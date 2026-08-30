import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACADEMIC_CALENDAR_PARSER_VERSION,
  mergeWeeklyCalendarIntoAcademicCalendar,
  parseTeachingScheduleText,
  parseWeeklyCalendarText,
} from '../core/academic-calendar-analysis.mjs'
import {
  createAcademicCalendarAssetsClient,
  sourceUrlFromCalendarPage,
  sourceUrlFromPdfPage,
} from '../src/mobile/academic-calendar-assets.mjs'
import { OFFICIAL_ACADEMIC_CALENDAR } from '../core/academic-calendar.mjs'

test('academic calendar source discovery keeps the official high-resolution image and PDF links', () => {
  assert.match(sourceUrlFromCalendarPage('<img src="/_upload/article/images/ea/33/calendar-id.jpg">'), /calendar-id_d\.jpg$/u)
  assert.equal(sourceUrlFromPdfPage('<a href="/_upload/article/files/aa/bb/weekly-id.pdf">周历</a>'), 'https://jiaowuchu.buct.edu.cn/_upload/article/files/aa/bb/weekly-id.pdf')
})

test('weekly calendar parser repairs PDF text spacing and extracts selection windows', () => {
  const parsed = parseWeeklyCalendarText(`2025 - 2026 学年第二学期本科教学工作周历（学生版）
周 次 日 期 星 期 事 项
1 ～ 2   3 月 3 日～ 3 月 13 日   二～五   学生网上退补选本学期课程，重修选课
8   4 月 20 日～ 4 月 24 日   一～五   学生网上选第三学期课程
第 3 学期第 1 - 3 周   7 月 6 日～ 7 月 24 日   一～五   组织大类分专业工作
开学前 1 周   8 月 24 日 ~ 8 月 28 日   一～五   学生网上正选下学期课程
`)
  assert.equal(parsed.academicYear, '2025-2026')
  assert.equal(parsed.semester, '第二学期')
  assert.equal(parsed.entries[0].startDate, '2026-03-03')
  assert.equal(parsed.entries[0].endDate, '2026-03-13')
  assert.equal(parsed.courseSelectionWindows.length, 3)
  assert.equal(parsed.entries[2].weekStart, 1)
  assert.equal(parsed.entries[2].weekEnd, 3)
  assert.equal(parsed.entries[3].weekLabel, '开学前1周')
})

test('teaching schedule parser retains cohort rows and teaching phases', () => {
  const parsed = parseTeachingScheduleText(`北京化工大学 2026 - 2027 学年第一学期本科生教学进程表
备注：表中“A”为数据结构课程设计
2026 级新生 入学教育和军训 教学 15 周 考试
2025 级计科、大数据 教学 9 周 考试 教学 8 周 B 考试
校 历 班 级`)
  assert.equal(parsed.academicYear, '2026-2027')
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.match.selected, null)
  assert.deepEqual(parsed.rows[0].schedule.phases.slice(0, 2), [{ kind: 'teaching', weeks: 15 }, { kind: 'exam' }])
})

test('teaching schedule parser continues across PDF page headers', () => {
  const parsed = parseTeachingScheduleText(`2026-2027 学年第一学期本科生教学进程表
2025 级计科、大数据 教学 9 周 考试
北京化工大学 2026-2027 学年第一学期本科生教学进程表
校 历 班 级
2024 级计科、大数据 教学 9 周 考试`)
  assert.equal(parsed.rows.length, 2)
  assert.deepEqual(parsed.rows.map((row) => row.cohortYear), [2025, 2024])
})

test('weekly calendar updates only the matching academic-year semester', () => {
  const weekly = parseWeeklyCalendarText(`2026-2027 学年第一学期本科教学工作周历
1 8 月 31 日～9 月 6 日 一～日 新学期第一天
20 1 月 11 日～1 月 17 日 一～日 期末考试
`)
  const merged = mergeWeeklyCalendarIntoAcademicCalendar(OFFICIAL_ACADEMIC_CALENDAR, weekly)
  assert.equal(merged.semesters[0].startDate, '2026-08-31')
  assert.equal(merged.semesters[0].endDate, '2027-01-17')
})

test('third-semester weekly data never overwrites an existing semester', () => {
  const weekly = {
    academicYear: OFFICIAL_ACADEMIC_CALENDAR.schoolYear,
    semester: '第三学期',
    entries: [{ weekStart: 1, weekEnd: 4, startDate: '2027-07-12', endDate: '2027-08-08' }],
  }
  const merged = mergeWeeklyCalendarIntoAcademicCalendar(OFFICIAL_ACADEMIC_CALENDAR, weekly)
  assert.equal(merged, OFFICIAL_ACADEMIC_CALENDAR)
  assert.equal(merged.semesters[1].endDate, '2027-07-11')
})

test('academic calendar client caches three resources and parsed analysis', async () => {
  let calls = 0
  const pages = {
    calendar: '<img src="/_upload/article/images/aa/bb/calendar-id.jpg">',
    teachingSchedule: '<a href="/_upload/article/files/aa/bb/teaching-id.pdf">教学进程</a>',
    weeklyCalendar: '<a href="/_upload/article/files/aa/bb/weekly-id.pdf">周历</a>',
  }
  const client = createAcademicCalendarAssetsClient({
    fetchImpl: async (url) => {
      calls += 1
      const value = String(url)
      if (value.endsWith('page.htm') && value.includes('c3201a46856')) return new Response(pages.calendar)
      if (value.endsWith('page.htm') && value.includes('c3207a46873')) return new Response(pages.teachingSchedule)
      if (value.endsWith('page.htm') && value.includes('c3199a46850')) return new Response(pages.weeklyCalendar)
      if (value.endsWith('_d.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
      return new Response(new TextEncoder().encode('%PDF-1.7\nfixture'))
    },
    pdfTextReader: async (bytes) => bytes[0] === 0x25 ? '2026-2027 学年第一学期本科教学工作周历\n1 8 月 31 日～9 月 6 日 一～日 新学期第一天' : '',
  })
  const first = await client.refresh({ force: true })
  assert.equal(calls, 6)
  assert.equal(first.assets.calendar.bytes, 4)
  assert.equal(first.analysis.parserVersion, ACADEMIC_CALENDAR_PARSER_VERSION)
  assert.equal(first.analysis.weeklyCalendar.entries.length, 1)
  await client.refresh()
  assert.equal(calls, 6)
})

test('academic calendar client retries a failed PDF analysis on the next refresh', async () => {
  let reads = 0
  const client = createAcademicCalendarAssetsClient({
    fetchImpl: async (url) => {
      const value = String(url)
      if (value.endsWith('page.htm')) return new Response('<a href="/_upload/article/files/aa/bb/resource.pdf">资源</a>')
      return new Response(new TextEncoder().encode('%PDF-1.7\nfixture'))
    },
    pdfTextReader: async () => {
      reads += 1
      if (reads === 1) throw new Error('worker failed')
      return '2026-2027 学年第一学期本科教学工作周历\n1 8 月 31 日～9 月 6 日 一～日 新学期第一天'
    },
  })
  const first = await client.refresh({ force: true })
  assert.match(first.analysisError, /工作周历/u)
  assert.equal(client.needsRefresh(), true)
  const second = await client.refresh()
  assert.equal(second.analysisError, null)
  assert.equal(second.analysis.weeklyCalendar.entries.length, 1)
  assert.equal(reads, 4)
})

test('academic calendar client follows same-origin resource redirects', async () => {
  let calls = 0
  const pages = {
    calendar: '<img src="/_upload/article/images/aa/bb/calendar-id.jpg">',
    teachingSchedule: '<a href="/_upload/article/files/aa/bb/teaching-id.pdf">教学进程</a>',
    weeklyCalendar: '<a href="/_upload/article/files/aa/bb/weekly-id.pdf">周历</a>',
  }
  const fetchImpl = async (url) => {
    calls += 1
    const value = String(url)
    if (value.endsWith('page.htm')) return new Response(null, { status: 301, headers: { location: `${value}?published=1` } })
    if (value.includes('published=1')) {
      const pageKey = value.includes('c3201a46856') ? 'calendar' : value.includes('c3207a46873') ? 'teachingSchedule' : 'weeklyCalendar'
      return new Response(pages[pageKey])
    }
    if (value.endsWith('_d.jpg')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
    return new Response(new TextEncoder().encode('%PDF-1.7\nfixture'))
  }
  const client = createAcademicCalendarAssetsClient({ fetchImpl })
  const snapshot = await client.refresh({ force: true })
  assert.equal(calls, 9)
  assert.equal(snapshot.assets.calendar.bytes, 4)
  assert.equal(snapshot.assets.teachingSchedule.bytes, 16)
  assert.equal(snapshot.assets.weeklyCalendar.bytes, 16)
})

test('academic calendar client accepts native bridge redirect headers', async () => {
  const pages = {
    calendar: '<img src="/_upload/article/images/aa/bb/calendar-id.jpg">',
    teachingSchedule: '<a href="/_upload/article/files/aa/bb/teaching-id.pdf">教学进程</a>',
    weeklyCalendar: '<a href="/_upload/article/files/aa/bb/weekly-id.pdf">周历</a>',
  }
  const binary = (value) => new Uint8Array(value).buffer
  const response = (status, headers, value) => ({
    status,
    headers,
    ok: status >= 200 && status < 300,
    text: async () => String(value || ''),
    arrayBuffer: async () => binary(value),
  })
  const client = createAcademicCalendarAssetsClient({
    fetchImpl: async (url) => {
      const value = String(url)
      if (value.endsWith('page.htm')) {
        return response(301, { Location: [`http://jiaowuchu.buct.edu.cn${new URL(value).pathname}?published=1`] }, '')
      }
      if (value.includes('published=1')) {
        const pageKey = value.includes('c3201a46856') ? 'calendar' : value.includes('c3207a46873') ? 'teachingSchedule' : 'weeklyCalendar'
        return response(200, { 'Content-Type': 'text/html' }, pages[pageKey])
      }
      if (value.endsWith('_d.jpg')) return response(200, { 'Content-Type': 'image/jpeg' }, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
      return response(200, { 'Content-Type': 'application/pdf' }, new TextEncoder().encode('%PDF-1.7\nfixture'))
    },
  })
  const snapshot = await client.refresh({ force: true })
  assert.equal(snapshot.assets.calendar.bytes, 4)
  assert.equal(snapshot.assets.teachingSchedule.bytes, 16)
  assert.equal(snapshot.assets.weeklyCalendar.bytes, 16)
})
