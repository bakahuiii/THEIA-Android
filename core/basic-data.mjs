function cleanString(value, fallback = '') {
  const text = String(value ?? '').trim()
  return text || fallback
}

import { academicCalendarForTerms, currentAcademicWeek } from './academic-calendar.mjs'
import { normalizeTermCode } from './term-utils.mjs'

function currentTerm(data) {
  return data?.currentTerm || (Array.isArray(data?.terms) && data.terms.length ? data.terms[0] : null)
}

function sameTerm(left, right) {
  if (!left || !right) return false
  return Number(left.year) === Number(right.year) && normalizeTermCode(left.term) === normalizeTermCode(right.term)
}

function domainOutcome(result, domain) {
  return result?.domainOutcomes?.[domain] || null
}

function shouldPreserveEmpty(value, previous, outcome) {
  return Array.isArray(value)
    && value.length === 0
    && Array.isArray(previous)
    && previous.length > 0
    && outcome?.emptyConfirmed !== true
    && outcome?.contentEmptyConfirmed !== true
}

function listValue(result, domain, previous = []) {
  const value = result?.[domain]
  if (!Array.isArray(value)) return Array.isArray(previous) ? previous : []
  const outcome = domainOutcome(result, domain)
  if (outcome?.succeeded === false || outcome?.status === 'failed') return Array.isArray(previous) ? previous : value
  if (shouldPreserveEmpty(value, previous, outcome)) return previous
  return value
}

function objectValue(result, domain, previous = null) {
  const value = result?.[domain]
  if (!value || typeof value !== 'object') return previous
  const outcome = domainOutcome(result, domain)
  if (outcome?.succeeded === false || outcome?.status === 'failed') return previous || value
  return value
}

function pickSchedule(item) {
  const weekday = Number(item?.weekday)
  return {
    id: cleanString(item?.id),
    title: cleanString(item?.title, '未命名课程'),
    courseCode: cleanString(item?.courseCode),
    teacher: cleanString(item?.teacher),
    room: cleanString(item?.room),
    weekday: Number.isInteger(weekday) ? weekday : null,
    period: cleanString(item?.period),
    weeks: cleanString(item?.weeks),
    startAt: item?.startAt || null,
    endAt: item?.endAt || null,
    termId: cleanString(item?.termId),
  }
}

function pickExam(item) {
  return {
    id: cleanString(item?.id),
    courseName: cleanString(item?.courseName, '未命名考试'),
    courseCode: cleanString(item?.courseCode),
    examType: cleanString(item?.examType),
    examTime: cleanString(item?.examTime),
    startAt: item?.startAt || null,
    location: cleanString(item?.location),
    campus: cleanString(item?.campus),
    seat: cleanString(item?.seat),
    remark: cleanString(item?.remark),
    termId: cleanString(item?.termId),
  }
}

function pickGrade(item) {
  return {
    id: cleanString(item?.id),
    courseName: cleanString(item?.courseName, '未命名课程'),
    courseCode: cleanString(item?.courseCode),
    academicYear: cleanString(item?.academicYear),
    term: cleanString(item?.term),
    courseInternalId: cleanString(item?.courseInternalId),
    classInternalId: cleanString(item?.classInternalId),
    category: cleanString(item?.category),
    nature: cleanString(item?.nature),
    credits: item?.credits ?? null,
    score: cleanString(item?.score),
    point: item?.point ?? null,
    teacher: cleanString(item?.teacher),
    assessment: cleanString(item?.assessment),
    remark: cleanString(item?.remark),
    status: cleanString(item?.status),
    publishedAt: item?.publishedAt || item?.releaseAt || item?.publishDate || item?.publishedDate || item?.createdAt || null,
    releaseAt: item?.releaseAt || item?.releaseDate || null,
    updatedAt: item?.updatedAt || item?.updatedDate || item?.modifiedAt || item?.lastModified || null,
    termId: cleanString(item?.termId),
  }
}

function pickNotice(item) {
  return {
    id: cleanString(item?.id),
    title: cleanString(item?.title, '教务通知'),
    summary: cleanString(item?.summary),
    source: cleanString(item?.source, 'jwglxt'),
    sourceUrl: cleanString(item?.sourceUrl),
    publishedAt: item?.publishedAt || null,
  }
}

function mergeAcademicExtras(next, previous, result) {
  const prior = previous && typeof previous === 'object' ? previous : {}
  const current = next && typeof next === 'object' ? next : {}
  const priorDomains = prior.domains && typeof prior.domains === 'object' ? prior.domains : {}
  const currentDomains = current.domains && typeof current.domains === 'object' ? current.domains : {}
  const domains = { ...priorDomains }
  for (const [domain, value] of Object.entries(currentDomains)) {
    const outcome = domainOutcome(result, domain)
    const old = priorDomains[domain]
    if (outcome?.succeeded === false || outcome?.status === 'failed') {
      if (old === undefined) domains[domain] = value
      continue
    }
    if (value && typeof value === 'object' && old && typeof old === 'object') {
      const merged = { ...old, ...value }
      for (const key of ['records', 'attachments', 'options']) {
        if (shouldPreserveEmpty(value[key], old[key], outcome)) merged[key] = old[key]
      }
      domains[domain] = merged
    } else {
      domains[domain] = value
    }
  }
  return {
    ...prior,
    ...current,
    domains,
  }
}

export function buildBasicData(result, username, previous = null) {
  const profile = result?.profile && typeof result.profile === 'object' ? result.profile : {}
  const prior = previous && typeof previous === 'object' ? previous : {}
  const rawTerms = listValue(result, 'terms', prior.terms).slice(0, 40)
  const calendar = academicCalendarForTerms(rawTerms)
  const mappedTerms = calendar.terms.slice()
  const officialCurrent = currentAcademicWeek(calendar)
  const calendarTerm = officialCurrent?.year && officialCurrent?.term
    ? mappedTerms.find((term) => sameTerm(term, officialCurrent)) || {
      ...officialCurrent,
      id: officialCurrent.termId || `${officialCurrent.year}-${officialCurrent.term}`,
      upcoming: undefined,
    }
    : null
  const hintedCurrent = result?.currentTerm || prior.currentTerm || mappedTerms[0] || null
  const activeTerm = calendarTerm
    || mappedTerms.find((term) => sameTerm(term, hintedCurrent))
    || hintedCurrent
  const terms = calendarTerm && !mappedTerms.some((term) => sameTerm(term, calendarTerm))
    ? [calendarTerm, ...mappedTerms]
    : mappedTerms
  return {
    user: {
      name: cleanString(profile.name, prior.user?.name || '同学'),
      studentId: cleanString(profile.studentId, prior.user?.studentId),
      gpa: profile.gpa ?? prior.user?.gpa ?? null,
      username: cleanString(username),
    },
    currentTerm: activeTerm,
    terms,
    schedule: listValue(result, 'schedule', prior.schedule).map(pickSchedule),
    exams: listValue(result, 'exams', prior.exams).map(pickExam),
    grades: listValue(result, 'grades', prior.grades).map(pickGrade),
    courses: listValue(result, 'courses', prior.courses).slice(0, 300),
    selectedCourses: listValue(result, 'selectedCourses', prior.selectedCourses).slice(0, 500),
    notices: listValue(result, 'notices', prior.notices).map(pickNotice).slice(0, 120),
    academicProgress: objectValue(result, 'academicProgress', prior.academicProgress),
    academicExtras: mergeAcademicExtras(result?.academicExtras, prior.academicExtras, result),
    academicCalendar: result?.academicCalendar || prior.academicCalendar || calendar,
    updatedAt: result?.capturedAt || prior.updatedAt || new Date().toISOString(),
    partialErrors: Array.isArray(result?.errors) ? result.errors.slice(0, 4).map((error) => cleanString(error).slice(0, 320)) : [],
  }
}

export function publicBasicError(error) {
  return cleanString(error?.message || error, '请求失败').replace(/[\r\n]+/g, ' ').slice(0, 320) || '请求失败'
}
