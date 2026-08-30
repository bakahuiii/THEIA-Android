// Browser-safe parsing for the three official academic-calendar resources.
// PDF text extraction is supplied by the mobile client; this module only
// turns the extracted text into deterministic, small JSON records.

export const ACADEMIC_CALENDAR_ANALYSIS_SCHEMA = 'theia-basic-academic-calendar-analysis/v1'
export const ACADEMIC_CALENDAR_PARSER_VERSION = '2026-08-30.2'

function clean(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim()
}

function compact(value) {
  return clean(value).replace(/\s+/g, '')
}

function academicYearOf(value) {
  const text = compact(value).replace(/[－–—]/g, '-')
  const match = text.match(/(20\d{2})-(20\d{2})/u)
  return match ? `${match[1]}-${match[2]}` : null
}

function semesterOf(value) {
  return compact(value).match(/第[一二三四\d]+学期/u)?.[0] || null
}

function semesterNumber(value) {
  const match = compact(value).match(/第([一二三四\d]+)学期/u)
  if (!match) return null
  return ({ 一: 1, 二: 2, 三: 3, 四: 4 }[match[1]] || Number(match[1])) || null
}

function semesterYear(schoolYear, month, semester) {
  const start = Number(String(schoolYear || '').slice(0, 4))
  if (!Number.isInteger(start) || !month) return null
  const number = semesterNumber(semester)
  return ((number === 1 && month <= 7) || (number !== 1 && month <= 8)) ? start + 1 : start
}

function dateIso(year, month, day) {
  if (!year || !month || !day) return null
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null
  return date.toISOString().slice(0, 10)
}

function parseDateRange(value, schoolYear, semester) {
  const text = compact(value).replace(/[至到]/g, '～').replace(/[—–－-]/g, '～')
  const firstYear = String(schoolYear || '').match(/(20\d{2})/)?.[1]
  const make = (month, day, yearOverride = null) => dateIso(yearOverride || semesterYear(schoolYear, month, semester), month, day)
  const range = text.match(/(\d{1,2})月(\d{1,2})日～(\d{1,2})月(\d{1,2})日/u)
  if (range) {
    const startMonth = Number(range[1])
    const endMonth = Number(range[3])
    const startYear = semesterYear(schoolYear, startMonth, semester) || firstYear
    const endYear = endMonth < startMonth ? Number(startYear) + 1 : null
    return {
      startDate: make(startMonth, Number(range[2]), startYear),
      endDate: make(endMonth, Number(range[4]), endYear),
    }
  }
  const sameMonth = text.match(/(\d{1,2})月(\d{1,2})日～(\d{1,2})日/u)
  if (sameMonth) {
    return {
      startDate: make(Number(sameMonth[1]), Number(sameMonth[2])),
      endDate: make(Number(sameMonth[1]), Number(sameMonth[3])),
    }
  }
  const single = text.match(/(\d{1,2})月(\d{1,2})日/u)
  if (single) {
    const date = make(Number(single[1]), Number(single[2]))
    return { startDate: date, endDate: date }
  }
  return { startDate: null, endDate: null }
}

function parseWeekLabel(value) {
  const label = clean(value)
  const compactLabel = label.replace(/\s+/g, '')
  const numbers = [...compactLabel.matchAll(/\d+/g)].map((match) => Number(match[0]))
  const thirdSemester = compactLabel.match(/第\d+学期第(\d+)(?:[-～~—–－]([\d]+))?周/u)
  if (thirdSemester) {
    return {
      weekLabel: label,
      weekStart: Number(thirdSemester[1]),
      weekEnd: Number(thirdSemester[2] || thirdSemester[1]),
      semesterNumber: Number(compactLabel.match(/第(\d+)学期/u)?.[1]) || null,
    }
  }
  return {
    weekLabel: label,
    weekStart: numbers[0] ?? null,
    weekEnd: numbers[numbers.length - 1] ?? null,
    semesterNumber: null,
  }
}

function courseSelectionWindow(entry) {
  if (!entry?.startDate || !entry?.endDate || !/选.*课|课程.*选/u.test(entry.summary || '')) return null
  if (/论文|设计.*题目|题目.*补选/u.test(entry.summary)) return null
  return {
    id: `selection-window:${entry.id}`,
    sourceEntryId: entry.id,
    summary: entry.summary,
    dateText: entry.dateText,
    weekdayText: entry.weekdayText,
    startDate: entry.startDate,
    endDate: entry.endDate,
    startAt: `${entry.startDate}T00:00`,
    endAt: `${entry.endDate}T23:59`,
  }
}

function normalizeWeeklyLine(value) {
  return clean(value)
    .replace(/第\s*\d+\s*学期\s*第\s*\d+\s*(?:[-～~—–－]\s*\d+\s*)?周/gu, (match) => match.replace(/\s+/gu, ''))
    .replace(/开学前\s*\d+\s*周/gu, (match) => match.replace(/\s+/gu, ''))
    .replace(/(\d)\s*(月|日)/gu, '$1$2')
    .replace(/(\d{1,2})月\s+(\d{1,2})日/gu, '$1月$2日')
    .replace(/([月日])\s+(?=\d)/gu, '$1')
    .replace(/([月日])\s*([～~—–－-])\s*(?=\d)/gu, '$1$2')
    .replace(/(\d)\s*[～~—–－-]\s*(\d)/gu, '$1～$2')
    .replace(/([一二三四五六日])\s*[～~—–－-]\s*([一二三四五六日])/gu, '$1～$2')
}

export function parseWeeklyCalendarText(text, options = {}) {
  const source = String(text || '').replace(/\r/g, '')
  const lines = source.split('\n')
  const header = lines.find((line) => /学年.*学期.*周历/u.test(compact(line))) || ''
  const academicYear = academicYearOf(header)
  const semester = semesterOf(header)
  const body = source.split(/【\s*备注\s*】|\[\s*备注\s*\]/u, 1)[0]
  const entries = []
  for (const rawLine of body.split('\n')) {
    const line = normalizeWeeklyLine(rawLine)
    if (!line || /^(北京化工大学|周\s*次|--|\d+ of \d+)/u.test(line) || /学年.*周历/u.test(compact(line))) continue
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/u)
    const compactMatch = line.match(/^(\S+)\s+(\S+)\s+(.+)$/u)
    const weekValue = match?.[1] || compactMatch?.[1]
    if (!weekValue || !/^\d|^第|^开学前/u.test(weekValue)) continue
    const weeks = parseWeekLabel(weekValue)
    const dateText = match?.[2] || compactMatch?.[2]
    const dates = parseDateRange(dateText, academicYear, semester)
    const summary = clean(match?.[4] || compactMatch?.[3])
    if (!summary || (dates.startDate && dates.endDate && dates.startDate > dates.endDate)) continue
    entries.push({
      id: `weekly:${entries.length}:${weekValue}:${summary.slice(0, 24)}`,
      ...weeks,
      dateText,
      weekdayText: match?.[3] || null,
      summary,
      ...dates,
    })
  }
  const notesText = source.match(/【\s*备注\s*】([\s\S]*)/u)?.[1] || source.match(/\[\s*备注\s*\]([\s\S]*)/u)?.[1] || ''
  const notes = notesText.split('\n').map(clean).filter(Boolean).slice(0, 80)
  return {
    schema: ACADEMIC_CALENDAR_ANALYSIS_SCHEMA,
    parserVersion: ACADEMIC_CALENDAR_PARSER_VERSION,
    source: { assetKey: 'weeklyCalendar', filename: options.filename || null, sourceUrl: options.sourceUrl || null, parsedAt: new Date().toISOString() },
    academicYear,
    semester,
    entries,
    courseSelectionWindows: entries.map(courseSelectionWindow).filter(Boolean),
    notes,
  }
}

function markerNotesOf(text) {
  const notes = {}
  const normalized = String(text || '').replace(/\r/g, '').replace(/表中\s*/gu, '表中')
  const regex = /表中[“"']?([A-T])[”"']?\s*为\s*([\s\S]*?)(?=\n?\s*\d+[．.]\s*表中|$)/gu
  for (const match of normalized.matchAll(regex)) notes[match[1]] = compact(match[2]).replace(/[。；;]+$/u, '')
  return notes
}

function classGroupsOf(classText) {
  return compact(classText.replace(/^20\d{2}级/u, ''))
    .split(/[、,，]/u)
    .map((item) => item.replace(/[（(].*$/u, '').trim())
    .filter(Boolean)
}

function parseSchedule(scheduleText) {
  const text = clean(scheduleText)
  const teachingWeeks = Number(text.match(/教学\s*(\d+)\s*周/u)?.[1]) || null
  const phases = []
  if (teachingWeeks) phases.push({ kind: 'teaching', weeks: teachingWeeks })
  if (/考试/u.test(text)) phases.push({ kind: 'exam' })
  for (const match of text.matchAll(/(生产实习|毕业环节|毕业设计|课程设计|小学期)(?:\s*(\d{1,2})\s*周)?/gu)) {
    if (!phases.some((phase) => phase.kind === match[1])) phases.push({ kind: match[1], weeks: match[2] ? Number(match[2]) : null })
  }
  const markers = [...new Set([...text.matchAll(/(?:^|[^A-Za-z])([A-T])(?:$|[^A-Za-z])/gu)].map((match) => match[1]))]
  return { teachingWeeks, examWeeks: /考试/u.test(text), phases, markers }
}

function cohortStartOf(value) {
  const text = compact(value)
  const full = text.match(/^(20\d{2})级/u)
  if (full) return { year: full[1], prefix: full[0] }
  const short = text.match(/^(\d{2})级/u)
  if (short) return { year: `20${short[1]}`, prefix: short[0] }
  const special = text.match(/^(20\d{2})(?=第二学位|预科)/u)
  if (special) return { year: special[1], prefix: special[0] }
  return null
}

function teachingSignal(value) {
  return /教学|考试|实习|实训|工程训练|电子课设|毕业|色彩写生|认识|课程设计|综合/u.test(compact(value))
}

function rowGroups(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((value) => {
    return clean(value)
  }).filter(Boolean)
  const rows = []
  let parts = null
  let lastCohortYear = null
  let seenRow = false
  const flush = () => { if (parts?.length) rows.push(parts.join(' ')); parts = null }
  for (const line of lines) {
    const compactLine = compact(line)
    const cohort = cohortStartOf(line)
    if (/^北京化工大学|^校历|^班级/u.test(compactLine)) {
      flush()
      continue
    }
    if (/^\d+[．.]?表中/u.test(compactLine) || /^\d+of\d+$/iu.test(compactLine)) continue
    if (cohort) {
      const pageHeader = /周为|校历|班级/u.test(compactLine) && !teachingSignal(compactLine)
      if (!seenRow && pageHeader) continue
      flush()
      lastCohortYear = cohort.year
      parts = [line]
      seenRow = true
      continue
    }
    if (!seenRow) continue
    const lawCohort = /^法学[A-Z]\d/u.test(compactLine) ? lastCohortYear : null
    if (lawCohort) parts.push(`${lawCohort}级${line}`)
    else if (parts) parts.push(line)
  }
  flush()
  return rows
}

function parseTeachingRow(row, markerNotes) {
  const compactRow = compact(row).replace(/^(\d{2})级/u, '20$1级')
  const cohort = cohortStartOf(compactRow)
  if (!cohort) return null
  const cohortYear = Number(cohort.year)
  const rest = compactRow.slice(cohort.prefix.length)
  const scheduleIndex = rest.search(/教学|毕业环节|毕业设计|毕设设计|法学|小学期/u)
  const classText = scheduleIndex >= 0 ? rest.slice(0, scheduleIndex) : rest
  const scheduleText = scheduleIndex >= 0 ? rest.slice(scheduleIndex) : ''
  const schedule = parseSchedule(scheduleText)
  return {
    cohortYear,
    classGroups: classGroupsOf(`${cohortYear}级${classText}`),
    rawClassText: `${cohortYear}级${classText}`,
    schedule,
    rawScheduleText: scheduleText,
    markers: schedule.markers,
    markerNotes: Object.fromEntries(schedule.markers.filter((key) => markerNotes[key]).map((key) => [key, markerNotes[key]])),
  }
}

export function inferAcademicTrack({ profile = null, courses = [], academicTrack = null } = {}) {
  const studentId = String(profile?.studentId || '')
  const cohortYear = /^20\d{2}/u.test(studentId) ? Number(studentId.slice(0, 4)) : null
  const explicit = (Array.isArray(academicTrack) ? academicTrack : academicTrack ? [academicTrack] : [])
    .map((value) => String(value).trim()).filter(Boolean)
  const tableAliases = { 高材: ['材料'], 功材: ['材料'], 高分子材料: ['材料'] }
  const courseSignals = ['材料', '高材', '功材', '自动化', '机工', '装备', '机实', '大数据', '计科', '测控', '信工', '通信', '国贸', '会计', '财管', '生工', '生高', '生信', '生医', '制药', '数媒']
  const haystack = courses.map((course) => `${course?.title || ''} ${course?.category || ''} ${course?.department || ''}`).join(' ')
  const courseKeywords = courseSignals.filter((keyword) => haystack.includes(keyword))
  const aliases = explicit.flatMap((keyword) => tableAliases[keyword] || [])
  const keywords = [...new Set([...explicit, ...aliases, ...courseKeywords])]
  return { cohortYear, keywords, basis: [cohortYear ? `studentId:${cohortYear}` : null, ...explicit.map((keyword) => `profile.academicTrack:${keyword}`), ...courseKeywords.map((keyword) => `course-text:${keyword}`)].filter(Boolean) }
}

export function parseTeachingScheduleText(text, options = {}) {
  const source = String(text || '').replace(/\r/g, '')
  const header = source.split('\n').find((line) => /学年.*教学进程表/u.test(compact(line))) || ''
  const firstRow = source.search(/\n?20\d{2}\s*级/u)
  const notes = markerNotesOf(source.slice(0, firstRow >= 0 ? firstRow : source.length))
  const rows = rowGroups(source).map((row) => parseTeachingRow(row, notes)).filter(Boolean)
  const track = inferAcademicTrack(options)
  const candidates = rows.filter((row) => !track.cohortYear || row.cohortYear === track.cohortYear)
  const matched = candidates.find((row) => track.keywords.some((keyword) => row.classGroups.includes(keyword) || row.rawClassText.includes(keyword))) || null
  return {
    schema: ACADEMIC_CALENDAR_ANALYSIS_SCHEMA,
    parserVersion: ACADEMIC_CALENDAR_PARSER_VERSION,
    source: { assetKey: 'teachingSchedule', filename: options.filename || null, sourceUrl: options.sourceUrl || null, parsedAt: new Date().toISOString() },
    academicYear: academicYearOf(header),
    semester: semesterOf(header),
    markerNotes: notes,
    rows,
    match: { status: matched ? 'matched' : candidates.length ? 'cohort-only' : 'unmatched', basis: track.basis, cohortYear: track.cohortYear, keywords: track.keywords, selected: matched },
  }
}

export function academicTrackContextKey(context = {}) {
  const track = inferAcademicTrack(context)
  return JSON.stringify({ cohortYear: track.cohortYear, keywords: [...track.keywords].sort() })
}

export function mergeWeeklyCalendarIntoAcademicCalendar(calendar, weekly) {
  const base = calendar && typeof calendar === 'object' ? calendar : {}
  const entries = Array.isArray(weekly?.entries) ? weekly.entries : []
  if (!entries.length || !weekly?.academicYear || weekly.academicYear !== base.schoolYear) return base
  const targetNumber = semesterNumber(weekly.semester)
  if (!targetNumber) return base
  const candidates = entries.filter((entry) => entry.semesterNumber == null && Number.isInteger(entry.weekStart) && entry.startDate && entry.endDate)
  const first = candidates.filter((entry) => entry.weekStart <= 1 && entry.weekEnd >= 1).sort((left, right) => left.startDate.localeCompare(right.startDate))[0]
  const last = candidates.slice().sort((left, right) => left.endDate.localeCompare(right.endDate)).pop()
  if (!first || !last || first.startDate > last.endDate) return base
  const existing = Array.isArray(base.semesters) ? base.semesters : []
  if (targetNumber > existing.length) return base
  const index = targetNumber - 1
  const target = existing[index]
  if (!target) return base
  const maxWeek = candidates.reduce((maximum, entry) => Math.max(maximum, Number(entry.weekEnd) || 0), 0)
  const semesters = existing.map((item, itemIndex) => itemIndex === index ? {
    ...item,
    startDate: first.startDate,
    endDate: last.endDate,
    weeks: Math.max(Number(item.weeks) || 0, maxWeek) || item.weeks,
  } : item)
  return { ...base, semesters }
}
