const DAY_MS = 24 * 60 * 60 * 1000
import { normalizeTermCode } from './term-utils.mjs'

// Published by the BUCT Academic Affairs Office on 2026-08-28. The image is
// bundled locally so the calendar remains useful when the campus site is slow
// or unavailable inside the Android WebView.
export const OFFICIAL_ACADEMIC_CALENDAR = Object.freeze({
  schema: 'theia-basic-academic-calendar/v1',
  schoolYear: '2026-2027',
  source: '北京化工大学教务处',
  sourceUrl: 'https://jiaowuchu.buct.edu.cn/2019/1125/c3201a46856/page.htm',
  publishedAt: '2026-08-28',
  asset: '/calendar-2026-2027.jpg',
  semesters: Object.freeze([
    Object.freeze({ label: '第一学期', year: 2026, term: '3', startDate: '2026-08-31', endDate: '2027-01-17', weeks: 20 }),
    Object.freeze({ label: '第二学期', year: 2026, term: '12', startDate: '2027-03-01', endDate: '2027-07-11', weeks: 19 }),
  ]),
  vacations: Object.freeze([
    Object.freeze({ label: '寒假', startDate: '2027-01-18', endDate: '2027-02-28' }),
    Object.freeze({ label: '暑期前入学活动周', startDate: '2027-07-12', endDate: '2027-07-25' }),
    Object.freeze({ label: '暑假', startDate: '2027-07-26', endDate: '2027-09-05' }),
  ]),
  specialDates: Object.freeze([{ label: '春节', date: '2027-02-06' }]),
  periodTimes: Object.freeze([
    Object.freeze({ period: 1, start: '08:00', end: '08:45' }),
    Object.freeze({ period: 2, start: '08:50', end: '09:35' }),
    Object.freeze({ period: 3, start: '09:45', end: '10:30' }),
    Object.freeze({ period: 4, start: '10:40', end: '11:25' }),
    Object.freeze({ period: 5, start: '11:30', end: '12:15' }),
    Object.freeze({ period: 6, start: '13:30', end: '14:15' }),
    Object.freeze({ period: 7, start: '14:20', end: '15:05' }),
    Object.freeze({ period: 8, start: '15:15', end: '16:00' }),
    Object.freeze({ period: 9, start: '16:05', end: '16:50' }),
    Object.freeze({ period: 10, start: '18:00', end: '18:45' }),
    Object.freeze({ period: 11, start: '18:50', end: '19:35' }),
    Object.freeze({ period: 12, start: '19:40', end: '20:25' }),
  ]),
})

export function academicCalendarForTerms(terms = []) {
  const sourceTerms = Array.isArray(terms) ? terms : []
  const mappedTerms = sourceTerms.map((term) => {
    const match = OFFICIAL_ACADEMIC_CALENDAR.semesters.find((semester) => (
      Number(term?.year) === semester.year && normalizeTermCode(term?.term) === semester.term
    ))
    return match ? { ...term, ...match, id: term.id || `${match.year}-${match.term}` } : term
  })
  return {
    ...OFFICIAL_ACADEMIC_CALENDAR,
    semesters: OFFICIAL_ACADEMIC_CALENDAR.semesters.map((semester) => ({
      ...semester,
      termId: mappedTerms.find((term) => term.year === semester.year && normalizeTermCode(term.term) === semester.term)?.id || `${semester.year}-${semester.term}`,
    })),
    terms: mappedTerms,
  }
}

export function currentAcademicWeek(calendar, value = new Date()) {
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value || ''))
  if (!Number.isFinite(time)) return null
  const semesters = Array.isArray(calendar?.semesters) ? calendar.semesters : []
  const semester = semesters.find((item) => {
    const start = Date.parse(`${item.startDate}T00:00:00`)
    const end = Date.parse(`${item.endDate}T23:59:59`)
    return Number.isFinite(start) && Number.isFinite(end) && time >= start && time <= end
  })
  if (!semester) {
    // Make the first teaching week visible shortly before the official term
    // starts. This avoids an apparently missing week in the app during the
    // registration/orientation days immediately before term opening.
    const upcoming = semesters
      .map((item) => ({ item, start: Date.parse(`${item.startDate}T00:00:00`) }))
      .filter(({ start }) => Number.isFinite(start) && start > time && start - time <= 14 * DAY_MS)
      .sort((left, right) => left.start - right.start)[0]?.item
    return upcoming ? { ...upcoming, week: 1, of: upcoming.weeks || null, upcoming: true } : null
  }
  const start = Date.parse(`${semester.startDate}T00:00:00`)
  const week = Math.max(1, Math.floor((time - start) / (7 * DAY_MS)) + 1)
  return { ...semester, week: Math.min(semester.weeks || 32, week), of: semester.weeks || null }
}

export function academicCalendarPhase(calendar, value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  // Calendar dates are campus-local dates. Using toISOString() here turns the
  // first minutes after midnight in China into the previous calendar day.
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const semester = (calendar?.semesters || []).find((item) => item.startDate <= iso && iso <= item.endDate)
  if (semester) return { kind: 'semester', ...semester }
  const vacation = (calendar?.vacations || []).find((item) => item.startDate <= iso && iso <= item.endDate)
  if (vacation) return { kind: 'vacation', ...vacation }
  const next = [...(calendar?.semesters || []), ...(calendar?.vacations || [])]
    .filter((item) => item.startDate > iso)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))[0]
  return next ? { kind: 'upcoming', ...next } : null
}

export function nextAcademicCalendarBoundary(calendar, value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return [...(calendar?.semesters || []), ...(calendar?.vacations || [])]
    .filter((item) => String(item?.startDate || '') > iso)
    .sort((left, right) => String(left.startDate).localeCompare(String(right.startDate)))[0]?.startDate || null
}
