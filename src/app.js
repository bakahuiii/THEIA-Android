import './mobile/compat.mjs'
import { JWGLXT_ACTIVE_EXTRA_DOMAIN_NAMES } from '../core/jwglxt-extra.mjs'
import { AcademicApiClient } from '../core/academic-api-client.mjs'
import { JwglxtAdapter, JWGLXT_URLS } from '../core/adapters/jwglxt.mjs'
import { CampusPageClient } from '../core/campus-page-client.mjs'
import { TheolBasicAdapter, THEOL_URLS } from '../core/adapters/theol-basic.mjs'
import { buildBasicData, publicBasicError } from '../core/basic-data.mjs'
import { occursInWeek, parsePeriodRange, scheduleDetailKey } from '../core/schedule-utils.mjs'
import { OFFICIAL_ACADEMIC_CALENDAR, academicCalendarPhase, currentAcademicWeek } from '../core/academic-calendar.mjs'
import { TERM_CODE_LABELS, canonicalTermId as canonicalTermIdValue, normalizeTermCode } from '../core/term-utils.mjs'
import { ACADEMIC_CALENDAR_PAGES, createAcademicCalendarAssetsClient } from './mobile/academic-calendar-assets.mjs'
import { extractAcademicCalendarPdfText, renderAcademicCalendarPdf } from './mobile/academic-calendar-pdf.mjs'
import { MotionVenueAdapter } from '../core/adapters/motion-basic.mjs'
import { isAcademicAuthFailure, syncWithRecovery } from '../core/auth-recovery.mjs'
import { clearCasSession, clearSavedCasSession, getCasSessionCookies, openCasLogin, openTheolLogin, readCasSession, saveCasSession } from './mobile/cas-auth.mjs'
import { createAttachmentStore } from './mobile/attachment-store.mjs'
import { nativeFetch } from './mobile/native-fetch.mjs'
import './styles.css'

const app = document.querySelector('#app')
const DAYS = ['一', '二', '三', '四', '五', '六', '日']
const SCHEDULE_COLOR_PALETTE = Object.freeze([
  { background: '#cfe8ff', border: '#3d82c4', ink: '#1f4f7d' },
  { background: '#d8f2dd', border: '#3d9b68', ink: '#205e3d' },
  { background: '#ffe8a6', border: '#d18b17', ink: '#704900' },
  { background: '#ffd3c9', border: '#d96855', ink: '#762f26' },
  { background: '#e4d9ff', border: '#795fc4', ink: '#493487' },
  { background: '#cbeeed', border: '#319994', ink: '#1e5d5a' },
  { background: '#ffddb7', border: '#d47b37', ink: '#733c17' },
  { background: '#d2ddff', border: '#6278cc', ink: '#3b4d91' },
  { background: '#e4f0b8', border: '#83a52f', ink: '#50651a' },
  { background: '#ffd1dd', border: '#d55d86', ink: '#792b49' },
  { background: '#eed8f2', border: '#a055a0', ink: '#672f67' },
  { background: '#c9eee4', border: '#3c9b7c', ink: '#245e4f' },
  { background: '#fff0a6', border: '#c99b18', ink: '#6f5500' },
  { background: '#d9e0e8', border: '#657486', ink: '#394957' },
])

function scheduleCourseKey(item) {
  return String(item?.courseCode || item?.classInternalId || item?.title || item?.room || '未命名课程')
    .trim()
    .normalize('NFKC')
    .toUpperCase()
}

function scheduleColorStart(key) {
  let hash = 2166136261
  for (const character of String(key)) {
    hash ^= character.codePointAt(0) || 0
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % SCHEDULE_COLOR_PALETTE.length
}

function scheduleColorDistance(left, right) {
  const rgb = (value) => {
    const hex = String(value || '').replace('#', '')
    return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) || 0)
  }
  const a = rgb(left?.background)
  const b = rgb(right?.background)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

function scheduleColorMap(items) {
  const keys = [...new Set((Array.isArray(items) ? items : []).map(scheduleCourseKey))].sort((left, right) => left.localeCompare(right, 'zh-CN'))
  const used = new Set()
  const colors = new Map()
  for (const key of keys) {
    const start = scheduleColorStart(key)
    const available = SCHEDULE_COLOR_PALETTE.map((_color, index) => index).filter((index) => !used.has(index))
    const candidates = available.length ? available : SCHEDULE_COLOR_PALETTE.map((_color, index) => index)
    const index = candidates.sort((left, right) => {
      const leftDistance = used.size
        ? Math.min(...[...used].map((usedIndex) => scheduleColorDistance(SCHEDULE_COLOR_PALETTE[left], SCHEDULE_COLOR_PALETTE[usedIndex])))
        : Number.POSITIVE_INFINITY
      const rightDistance = used.size
        ? Math.min(...[...used].map((usedIndex) => scheduleColorDistance(SCHEDULE_COLOR_PALETTE[right], SCHEDULE_COLOR_PALETTE[usedIndex])))
        : Number.POSITIVE_INFINITY
      if (rightDistance !== leftDistance) return rightDistance - leftDistance
      const leftOffset = (left - start + SCHEDULE_COLOR_PALETTE.length) % SCHEDULE_COLOR_PALETTE.length
      const rightOffset = (right - start + SCHEDULE_COLOR_PALETTE.length) % SCHEDULE_COLOR_PALETTE.length
      return leftOffset - rightOffset
    })[0]
    used.add(index)
    colors.set(key, SCHEDULE_COLOR_PALETTE[index])
  }
  return colors
}

function scheduleColorFor(item, colors) {
  return colors.get(scheduleCourseKey(item)) || SCHEDULE_COLOR_PALETTE[0]
}

function assetUrl(path) {
  const relative = String(path || '').replace(/^\/+/, '')
  return `./${relative}`
}

const MAP_TILE_SIZE = 2048
const MAP_HIGH_RES_ZOOM = 1.4
const MAP_HIGH_RES_TILE_LIMIT = 12

function mapTileSet(directory, width, height, extension) {
  const columns = Math.ceil(width / MAP_TILE_SIZE)
  const rows = Math.ceil(height / MAP_TILE_SIZE)
  return {
    directory,
    width,
    height,
    columns,
    rows,
    extension,
    columnWidths: Array.from({ length: columns }, (_value, index) => Math.min(MAP_TILE_SIZE, width - index * MAP_TILE_SIZE)),
    rowHeights: Array.from({ length: rows }, (_value, index) => Math.min(MAP_TILE_SIZE, height - index * MAP_TILE_SIZE)),
  }
}

function floorMapSources(building, dimensions) {
  return Object.fromEntries(dimensions.map(([width, height], index) => {
    const floor = index + 1
    const basename = `maps/${building}/floor-${floor}`
    const buildingLabel = building === 'first' ? '第一教学楼' : '第二教学楼'
    return [floor, {
      src: assetUrl(`${basename}.png`),
      mobileSrc: assetUrl(`${basename}.mobile.webp`),
      tiles: mapTileSet(`${building}/floor-${floor}`, width, height, 'png'),
      title: `${buildingLabel} ${floor} 层`,
      alt: `北京化工大学${buildingLabel} ${floor} 层平面图`,
    }]
  }))
}

const MAP_SOURCES = Object.freeze({
  campus: {
    src: assetUrl('maps/campus-map.jpg'),
    mobileSrc: assetUrl('maps/campus-map.mobile.jpg'),
    tiles: mapTileSet('campus-map', 6874, 10063, 'jpg'),
    title: '昌平校区',
    alt: '北京化工大学昌平校区地图',
  },
  satellite: {
    src: assetUrl('maps/campus-satellite.webp'),
    mobileSrc: assetUrl('maps/campus-satellite.mobile.webp'),
    tiles: mapTileSet('campus-satellite', 6874, 10063, 'webp'),
    title: '昌平校区卫星图',
    alt: '北京化工大学昌平校区卫星图',
  },
  first: floorMapSources('first', [[4918, 2516], [4820, 2531], [4813, 2527], [4792, 2473], [4835, 2509]]),
  second: floorMapSources('second', [[4368, 3433], [4368, 3433], [4368, 3433], [4368, 3433], [4368, 3433]]),
})
const PRIMARY_NAV = [
  ['overview', '总览', '⌂'],
  ['schedule', '课表', '▦'],
  ['map', '地图', '⌖'],
  ['records', '成绩', '∑'],
]
const MOBILE_NAV = [
  ['overview', '总览', '⌂'],
  ['schedule', '课表', '▦'],
  ['map', '地图', '⌖'],
  ['records', '成绩', '∑'],
  ['assignments', '作业与测试', '☑'],
  ['progress', '学业进度', '◒'],
  ['tools', '工具', '⌘'],
]
const TOOL_NAV = [
  ['assignments', '作业与测试', '☑'],
  ['tools', '学习工具', '⌘'],
  ['progress', '学业进度', '◒'],
  ['classrooms', '空闲教室', '⌕'],
  ['venues', '场馆查询', '⌁'],
  ['notices', '教务通知', '◌'],
  ['settings', '设置', '⚙'],
]
const OVERVIEW_TOOL_NAV = TOOL_NAV.filter(([id]) => !MOBILE_NAV.some(([mobileId]) => mobileId === id))
const EXTRA_DOMAIN_BY_VIEW = {
  plan: 'academic-plan',
}
const CORE_SYNC_DOMAINS = Object.freeze([
  'profile',
  'terms',
  'courses',
  'schedule',
  'grades',
  'exams',
  'academic-progress',
  'notices',
])
const SESSION_STORAGE_KEY = 'theia-basic.session.v1'
const NATIVE_BRIDGE_WAIT_MS = 2_000
const NATIVE_SESSION_READ_RETRIES = 3

  const state = {
  view: 'overview',
  viewHistory: [],
  recordsTab: 'grades',
  data: null,
  campus: null,
  theolData: { courses: [], assignments: [], notices: [] },
  theolLoading: false,
  theolLoaded: new Set(),
  theolError: '',
  theolAuthRequired: false,
  toolTab: 'calendar',
  loading: false,
  refreshing: false,
  extraLoading: new Set(),
  extraLoaded: new Set(),
  extraErrors: {},
  classroomSearching: false,
  classroomQueried: false,
  classroomStatus: '',
  classroomError: '',
  authenticating: false,
  venueCatalog: null,
  venueLoading: false,
  venueQuerying: false,
  venueError: '',
  venueCampus: '',
  venueId: '',
  venueDate: '',
  venueResult: null,
  restoringSession: true,
  authMode: '',
  authError: '',
  apiUsername: '',
  gradeDetailOpen: new Set(),
  gradeDetailPending: '',
  scheduleDetailOpen: '',
  scheduleGroupOpen: '',
  calendarWeekDetailOpen: '',
  planPdfOpening: false,
  planPdfError: '',
  planPdfUrl: '',
  academicCalendarPdfOpening: '',
  academicCalendarPdfError: '',
  academicCalendarAssets: {
    manifest: null,
    loading: false,
    refreshing: false,
    error: '',
  },
  map: {
    scope: 'campus',
    floor: 1,
    layer: 'campus',
    zoom: 1,
    x: 0,
    y: 0,
    hiresActive: false,
  },
  error: '',
  filters: {
    scheduleYear: '',
    scheduleSemester: '',
    scheduleMode: 'week',
    // Empty means automatic. A value is written only after the user chooses a
    // week, so the timetable can follow the current official calendar by default.
    scheduleWeek: '',
    selectedYear: '',
    selectedSemester: '',
    gradeYear: '',
    gradeSemester: '',
    examYear: '',
    examSemester: '',
    examMode: 'upcoming',
    courseQuery: '',
    theolQuery: '',
    assignmentMode: 'pending',
    toolDate: '',
    selectedQuery: '',
    noticeQuery: '',
    planQuery: '',
    freeYear: '',
    freeSemester: '',
    freeWeeks: '',
    freeWeekdays: '',
    freePeriods: '',
    freeCampus: '',
    freeBuilding: '',
    freeClassroomType: '',
    freeMinSeats: '',
    freeMaxSeats: '',
  },
}

let filterTimer = null
let authEpoch = 0
let venueRequestEpoch = 0
let sessionWriteQueue = Promise.resolve()

function authIsCurrent(epoch) {
  return epoch === authEpoch
}

function nativeApp() {
  try { return Boolean(window.Capacitor?.isNativePlatform?.()) } catch { return false }
}

async function waitForNativeBridge() {
  if (nativeApp()) return true
  const capacitor = typeof window === 'undefined' ? null : window.Capacitor
  if (!capacitor || capacitor.getPlatform?.() === 'web') return false
  const deadline = Date.now() + NATIVE_BRIDGE_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (nativeApp()) return true
  }
  return nativeApp()
}

function previewRequestUrl(url) {
  const target = new URL(String(url))
  return `/__theia-campus${target.pathname}${target.search}`
}

function previewCourseRequestUrl(url) {
  const target = new URL(String(url))
  const prefix = target.protocol === 'http:' ? '/__theia-course-http' : '/__theia-course'
  return `${prefix}${target.pathname}${target.search}`
}

function previewMotionRequestUrl(url) {
  const target = new URL(String(url))
  return `/__theia-motion${target.pathname}${target.search}`
}

function previewCalendarRequestUrl(url) {
  const target = new URL(String(url))
  return `/__theia-calendar${target.pathname}${target.search}`
}

function previewFetch(url, init = {}) {
  const headers = new Headers(init.headers || {})
  headers.delete('Cookie')
  return fetch(url, { ...init, headers, credentials: 'same-origin' })
}

async function previewMotionFetch(url, init = {}) {
  return previewFetch(previewMotionRequestUrl(new URL(String(url))), init)
}

let motionAdapter = null
let academicCalendarClient = null

function getMotionAdapter() {
  if (!motionAdapter) motionAdapter = new MotionVenueAdapter({ fetchImpl: nativeApp() ? nativeFetch : previewMotionFetch })
  return motionAdapter
}

function getAcademicCalendarClient() {
  if (academicCalendarClient) return academicCalendarClient
  academicCalendarClient = createAcademicCalendarAssetsClient({
    fetchImpl: nativeApp() ? nativeFetch : previewFetch,
    requestUrl: nativeApp() ? (url) => url : previewCalendarRequestUrl,
    pdfTextReader: extractAcademicCalendarPdfText,
    profileProvider: () => state.data?.user || null,
    coursesProvider: () => state.data?.courses || [],
    onDiagnostic: (event, fields) => console.debug('[theia-basic]', event, fields),
  })
  return academicCalendarClient
}

function applyAcademicCalendarSnapshot(snapshot) {
  if (!snapshot) return
  state.academicCalendarAssets.manifest = snapshot
  state.academicCalendarAssets.error = ''
  if (state.data && snapshot.calendar) state.data = { ...state.data, academicCalendar: snapshot.calendar }
}

function activeAcademicCalendar() {
  return state.academicCalendarAssets.manifest?.calendar || state.data?.academicCalendar || OFFICIAL_ACADEMIC_CALENDAR
}

async function loadAcademicCalendarAssets(force = false) {
  const client = getAcademicCalendarClient()
  if (state.academicCalendarAssets.loading) return
  state.academicCalendarAssets.loading = true
  state.academicCalendarAssets.refreshing = Boolean(force)
  state.academicCalendarAssets.error = ''
  if (state.view === 'tools') renderView()
  try {
    const loaded = await client.load()
    applyAcademicCalendarSnapshot(loaded)
    if (force || client.needsRefresh()) {
      state.academicCalendarAssets.refreshing = true
      applyAcademicCalendarSnapshot(await client.refresh({ force }))
    }
  } catch (error) {
    state.academicCalendarAssets.error = publicBasicError(error)
  } finally {
    state.academicCalendarAssets.loading = false
    state.academicCalendarAssets.refreshing = false
    if (state.data && state.academicCalendarAssets.manifest?.calendar) state.data = { ...state.data, academicCalendar: state.academicCalendarAssets.manifest.calendar }
    renderApp()
  }
}

function createCampus({ username = '', password = '', cookieHeader = '', casCookieHeader = '', theolCookieHeader = '', mode = 'cas' } = {}) {
  const clientOptions = {
    username,
    password,
    cookieHeader,
    timeoutMs: 30_000,
    ...(nativeApp() ? { fetchImpl: nativeFetch } : { requestUrl: previewRequestUrl, fetchImpl: previewFetch }),
    onDiagnostic: (event, fields) => console.debug('[theia-basic]', event, fields),
  }
  const client = new AcademicApiClient(clientOptions)
  const adapter = new JwglxtAdapter(client, {
    attachmentStore: createAttachmentStore(),
    academicProgressSource: 'api',
    scheduleEndpoints: [
      'kbcx/xskbcx_cxXsKb.html?gnmkdm=N2151',
      'kbcx/xskbcx_cxXsgrkb.html',
    ],
    onProgress: (progress) => {
      if (!progress?.label) return
      if (state.loading) setLoginStatus(progress.label)
      if (state.classroomSearching) state.classroomStatus = progress.label
    },
  })
  const theolClient = new CampusPageClient({
    // Keep the academic and THEOL cookie jars separate. A missing THEOL
    // hand-off must not masquerade as a valid course-platform session.
    cookieHeader: theolCookieHeader,
    timeoutMs: 30_000,
    ...(nativeApp() ? { fetchImpl: nativeFetch } : { requestUrl: previewCourseRequestUrl, fetchImpl: previewFetch }),
    onDiagnostic: (event, fields) => console.debug('[theia-basic]', event, fields),
  })
  const theolAdapter = new TheolBasicAdapter(theolClient, {
    onProgress: (progress) => {
      if (state.theolLoading && progress?.label) setLoginStatus(progress.label)
    },
  })
  return { username, mode, casCookieHeader, client, adapter, theolClient, theolAdapter }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function dateValue(value) {
  if (!value) return null
  const numeric = typeof value === 'number' || /^\d{10,13}$/u.test(String(value).trim())
    ? Number(value)
    : null
  if (Number.isFinite(numeric)) {
    const timestamp = String(value).trim().length === 10 ? numeric * 1000 : numeric
    const epoch = new Date(timestamp)
    if (Number.isFinite(epoch.getTime())) return epoch
  }
  const time = Date.parse(String(value))
  return Number.isFinite(time) ? new Date(time) : null
}

function dateLabel(value) {
  const date = dateValue(value)
  return date ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', weekday: 'short' }).format(date) : '日期待定'
}

function dateTimeLabel(value) {
  const date = dateValue(value)
  return date ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '时间待定'
}

function detailLine(values) {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join(' · ') || '暂无更多信息'
}

function termId(term) {
  if (!term) return ''
  const direct = term?.id || term?.termId
  if (direct) return canonicalTermId(direct)
  const parts = academicTermParts(term)
  return parts.year && parts.code ? `${parts.year}-${parts.code}` : ''
}

function normalizedTermCode(value) {
  return normalizeTermCode(value)
}

function academicTermParts(value) {
  const object = value && typeof value === 'object' ? value : {}
  const text = typeof value === 'string'
    ? value
    : [object.id, object.termId, object.label, object.academicYear, object.academicYearLabel, object.termLabel, object.term].filter(Boolean).join(' ')
  const idMatch = text.match(/(?:^|[^\d])(20\d{2})\s*-\s*(3|9|12|16|1|2)(?:$|[^\d])/u)
  const year = String(object.year ?? '').match(/20\d{2}/u)?.[0] || idMatch?.[1] || text.match(/20\d{2}/u)?.[0] || ''
  const objectTerm = String(object.term ?? object.semester ?? object.xqm ?? '').trim()
  const numericTerm = objectTerm.match(/^(?:第\s*)?(\d{1,2})(?:\s*学期)?$/u)?.[1]
  const semantic = text.match(/(第一|第二|第三)学期/u)?.[1]
  const code = normalizedTermCode(numericTerm || idMatch?.[2] || ({ 第一: '3', 第二: '12', 第三: '16' }[semantic] || ''))
  return { year: year ? Number(year) : null, code, name: TERM_CODE_LABELS[code] || (semantic ? `${semantic}学期` : '') }
}

function canonicalTermId(value) {
  return canonicalTermIdValue(value)
}

function termLabel(term) {
  if (!term) return '当前学期'
  const parts = academicTermParts(term)
  if (parts.year && parts.name) return `${parts.year}-${parts.year + 1}-${parts.name}`
  if (parts.name) return parts.name
  if (parts.year && parts.code) return `${parts.year}-${parts.year + 1}-第 ${parts.code} 学期`
  const raw = String(term?.label || '').trim()
  return raw || '当前学期'
}

function itemTermLabel(item) {
  if (!item?.termId && !item?.academicYear && !item?.term && !item?.termLabel) return '学期待定'
  return termLabel({
    id: item.termId,
    year: item.academicYear,
    term: item.term,
    label: item.termLabel,
  })
}

function termsOf(data) {
  const values = Array.isArray(data?.terms) ? data.terms.slice() : []
  if (data?.currentTerm && !values.some((term) => termId(term) === termId(data.currentTerm))) values.unshift(data.currentTerm)
  const seen = new Set()
  return values.filter((term) => {
    const id = termId(term)
    if (!id || seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function currentTerm(data) {
  const values = termsOf(data)
  const calendarWeek = currentAcademicWeek(data?.academicCalendar || OFFICIAL_ACADEMIC_CALENDAR)
  if (calendarWeek?.year && calendarWeek?.term) {
    return values.find((term) => sameAcademicTerm(term, calendarWeek)) || calendarWeek
  }
  return data?.currentTerm || values.slice().sort((left, right) => termId(right).localeCompare(termId(left), 'zh-CN'))[0] || null
}

function selectedTerm(data, filterKey) {
  const values = termsOf(data)
  const current = currentTerm(data)
  const prefix = String(filterKey).replace(/Term$/, '')
  const selectedYear = state.filters[`${prefix}Year`]
  const selectedSemester = state.filters[`${prefix}Semester`]
  if (selectedYear === '__all__' || selectedSemester === '__all__') return null
  const year = String(selectedYear || current?.year || values[0]?.year || '')
  const yearTerms = values.filter((term) => String(term?.year || '') === year)
  const selectedSemesterIsValid = yearTerms.some((term) => normalizedTermCode(term?.term) === normalizedTermCode(selectedSemester))
  const semester = String((selectedSemesterIsValid ? selectedSemester : '') || yearTerms.find((term) => normalizedTermCode(term.term) === normalizedTermCode(current?.term))?.term || yearTerms[0]?.term || '')
  return values.find((term) => String(term?.year || '') === year && normalizedTermCode(term?.term) === normalizedTermCode(semester))
    || yearTerms[0]
    || current
}

function semesterLabel(value) {
  const code = normalizedTermCode(value)
  return TERM_CODE_LABELS[code] || `第 ${value} 学期`
}

function termSelectionControls(data, filterKey, includeAll = false) {
  const values = termsOf(data)
  const prefix = String(filterKey).replace(/Term$/, '')
  const yearKey = `${prefix}Year`
  const semesterKey = `${prefix}Semester`
  const current = currentTerm(data)
  const selectedYear = state.filters[yearKey] || String(current?.year || values[0]?.year || '')
  const allYears = selectedYear === '__all__'
  const yearValues = [...new Set(values.map((term) => String(term?.year || '')).filter(Boolean))]
  const yearTerms = allYears ? values : values.filter((term) => String(term?.year || '') === selectedYear)
  const requestedSemester = String(state.filters[semesterKey] || '')
  const selectedSemesterIsValid = yearTerms.some((term) => normalizedTermCode(term?.term) === normalizedTermCode(requestedSemester))
  const selectedSemester = allYears ? '__all__' : String((selectedSemesterIsValid ? requestedSemester : '') || yearTerms.find((term) => normalizedTermCode(term.term) === normalizedTermCode(current?.term))?.term || yearTerms[0]?.term || '')
  const semesterValues = [...new Map(yearTerms.map((term) => [String(term?.term || ''), term])).values()].filter((term) => term.term)
  const yearOptions = `${includeAll ? `<option value="__all__" ${allYears ? 'selected' : ''}>全部学年</option>` : ''}${yearValues.map((year) => `<option value="${escapeHtml(year)}" ${!allYears && year === selectedYear ? 'selected' : ''}>${escapeHtml(`${year}-${Number(year) + 1} 学年`)}</option>`).join('')}`
  const semesterOptions = `${includeAll ? `<option value="__all__" ${selectedSemester === '__all__' ? 'selected' : ''}>全部学期</option>` : ''}${semesterValues.map((term) => `<option value="${escapeHtml(term.term)}" ${selectedSemester !== '__all__' && normalizedTermCode(term.term) === normalizedTermCode(selectedSemester) ? 'selected' : ''}>${escapeHtml(semesterLabel(term.term))}</option>`).join('')}`
  return `<div class="term-selectors"><label class="term-selector"><span>学年</span><select class="control-select" data-filter-key="${escapeHtml(yearKey)}">${yearOptions}</select></label><label class="term-selector"><span>学期</span><select class="control-select" data-filter-key="${escapeHtml(semesterKey)}">${semesterOptions}</select></label></div>`
}

function selectedTermLabel(data, filterKey) {
  const prefix = String(filterKey).replace(/Term$/, '')
  return state.filters[`${prefix}Year`] === '__all__' || state.filters[`${prefix}Semester`] === '__all__' ? '全部学期' : termLabel(selectedTerm(data, filterKey))
}

function sameAcademicTerm(left, right) {
  if (!left || !right) return false
  const normalize = (value) => normalizedTermCode(value)
  return Number(left.year) === Number(right.year) && normalize(left.term) === normalize(right.term)
}

function currentWeekForTerm(term, calendar, value = new Date()) {
  if (!term) return currentAcademicWeek(calendar, value)
  if (term.startDate) {
    const scoped = currentAcademicWeek({ ...calendar, semesters: [term] }, value)
    if (scoped) return scoped
  }
  // The portal sometimes omits dates from its term selector. Reuse the
  // published calendar only when the selected year/semester is the official
  // current term; historical selections must not be labelled as current.
  const official = currentAcademicWeek(calendar, value)
  return official && sameAcademicTerm(term, official) ? official : null
}

function itemsForTerm(items, term) {
  const source = Array.isArray(items) ? items : []
  const id = termId(term)
  if (!id) return source
  const scoped = source.filter((item) => canonicalTermId(item?.termId || (item?.academicYear && item?.term ? `${item.academicYear}-${item.term}` : '')))
  return source.filter((item) => {
    const itemId = canonicalTermId(item?.termId || (item?.academicYear && item?.term ? `${item.academicYear}-${item.term}` : ''))
    return itemId ? itemId === id : scoped.length === 0
  })
}

function scheduleItems(data) {
  return itemsForTerm(data?.schedule, selectedTerm(data, 'scheduleTerm'))
}

function examItems(data) {
  const termItems = itemsForTerm(data?.exams, selectedTerm(data, 'examTerm'))
  const sorted = [...termItems].sort((a, b) => {
    const left = dateValue(a.startAt || a.examTime)?.getTime() ?? Number.MAX_SAFE_INTEGER
    const right = dateValue(b.startAt || b.examTime)?.getTime() ?? Number.MAX_SAFE_INTEGER
    return left - right
  })
  if (state.filters.examMode === 'all') return sorted
  return sorted.filter((item) => {
    const time = dateValue(item.startAt || item.examTime)?.getTime()
    return time == null || time >= Date.now() - 24 * 60 * 60 * 1000
  })
}

function searchMatch(item, query) {
  const needle = String(query || '').trim().toLowerCase()
  if (!needle) return true
  return JSON.stringify(item || {}).toLowerCase().includes(needle)
}

function emptyState(label) {
  return `<div class="empty-state"><span class="empty-dot"></span><span>${escapeHtml(label)}</span></div>`
}

function setLoginStatus(message) {
  const element = document.querySelector('#login-status')
  if (element) element.textContent = message || '正在读取校园数据…'
}

function navigateTo(view) {
  const nextView = String(view || '').trim()
  if (!nextView || nextView === state.view) return
  state.viewHistory = [...state.viewHistory.slice(-24), state.view]
  state.view = nextView
  renderApp()
}

function goBack() {
  const previous = state.viewHistory.pop() || 'overview'
  if (previous === state.view) return
  state.view = previous
  renderApp()
}

function mergeCookieHeaders(...headers) {
  const cookies = new Map()
  for (const header of headers) {
    for (const part of String(header || '').split(';')) {
      const separator = part.indexOf('=')
      if (separator <= 0) continue
      const name = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      if (name && value) cookies.set(name, value)
    }
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
}

function campusCookieHeaders(campus) {
  return {
    academic: String(campus?.client?.cookieHeader?.() || ''),
    theol: String(campus?.theolClient?.cookieHeader?.() || ''),
  }
}

function sessionSnapshot(campus) {
  const cookies = campusCookieHeaders(campus)
  if (!cookies.academic && !cookies.theol) return null
  return {
    version: 1,
    username: String(campus?.username || '').trim(),
    mode: campus?.mode === 'api' ? 'api' : 'cas',
    casCookies: String(campus?.casCookieHeader || ''),
    academicCookies: cookies.academic,
    theolCookies: cookies.theol,
    cookies: mergeCookieHeaders(cookies.academic, cookies.theol),
    savedAt: new Date().toISOString(),
  }
}

function parsePersistedSession(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    const fallbackCookies = String(value?.cookies || '')
    const academicCookies = value?.academicCookies === undefined ? fallbackCookies : String(value.academicCookies || '')
    // Older snapshots only had one merged cookie header. Treat it as an
    // academic-session fallback and force THEOL to re-use the SSO hand-off;
    // sending that merged header to both hosts reintroduced cross-domain
    // authentication and caused misleading THEOL login failures.
    const theolCookies = value?.theolCookies === undefined ? '' : String(value.theolCookies || '')
    if (!value || value.version !== 1 || (!academicCookies.trim() && !theolCookies.trim())) return null
    return {
      username: String(value.username || '').trim(),
      mode: value.mode === 'api' ? 'api' : 'cas',
      casCookieHeader: String(value.casCookies || ''),
      cookieHeader: academicCookies,
      theolCookieHeader: theolCookies,
    }
  } catch {
    return null
  }
}

function readLegacyPersistedSession() {
  try { return localStorage.getItem(SESSION_STORAGE_KEY) || '' } catch { return '' }
}

async function readPersistedSession() {
  if (await waitForNativeBridge()) {
    let readError = null
    for (let attempt = 0; attempt < NATIVE_SESSION_READ_RETRIES; attempt += 1) {
      try {
        const saved = parsePersistedSession(await readCasSession())
        if (saved) return saved
        readError = null
        break
      } catch (error) {
        readError = error
        if (attempt + 1 < NATIVE_SESSION_READ_RETRIES) await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
      }
    }
    // A secure-storage/bridge error is different from an empty store. Keep
    // the encrypted snapshot intact and let the caller show a retryable error.
    if (readError) throw readError
    const legacyRaw = readLegacyPersistedSession()
    const legacy = parsePersistedSession(legacyRaw)
    if (legacy) {
      try {
        await saveCasSession(legacyRaw)
        localStorage.removeItem(SESSION_STORAGE_KEY)
      } catch { /* Keep the legacy snapshot until secure storage is available. */ }
      return legacy
    }
    return null
  }
  return parsePersistedSession(readLegacyPersistedSession())
}

function persistSession(campus) {
  const snapshot = sessionSnapshot(campus)
  if (!snapshot) return Promise.resolve(false)
  const write = async () => {
    try {
      if (nativeApp()) {
        await saveCasSession(JSON.stringify(snapshot))
        localStorage.removeItem(SESSION_STORAGE_KEY)
      } else {
        localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(snapshot))
      }
      return true
    } catch (error) {
      console.warn('[theia-basic] 本机校园会话保存失败', error)
      return false
    }
  }
  sessionWriteQueue = sessionWriteQueue.then(write, write)
  return sessionWriteQueue
}

function clearPersistedSession() {
  const clear = async () => {
    try {
      if (nativeApp()) await clearSavedCasSession()
      localStorage.removeItem(SESSION_STORAGE_KEY)
    } catch { /* storage may be unavailable */ }
  }
  sessionWriteQueue = sessionWriteQueue.then(clear, clear)
  return sessionWriteQueue
}

async function refreshNativeSessionCookies(campus) {
  if (!nativeApp() || !campus) return {}
  try {
    const auth = await getCasSessionCookies()
    const cas = String(auth?.casCookies || '')
    const academic = String(auth?.jwglxtCookies || '')
    const theol = String(auth?.theolCookies || '')
    if (cas.trim()) campus.casCookieHeader = mergeCookieHeaders(campus.casCookieHeader, cas)
    if (academic.trim()) campus.client.setCookieHeader(academic)
    if (theol.trim()) campus.theolClient.setCookieHeader(theol)
    return { cas, academic, theol }
  } catch {
    return { cas: '', academic: '', theol: '' }
  }
}

async function restoreCasSession(campus, epoch) {
  // The native CookieManager can still hold a valid CAS cookie even when an
  // older encrypted snapshot did not contain the new casCookies field.
  if (!nativeApp() || campus?.mode !== 'cas') return false
  try {
    const auth = await openCasLogin(JWGLXT_URLS.login, {
      cookieHeader: campus.casCookieHeader,
      academicCookieHeader: campus.client.cookieHeader(),
      automaticCas: true,
    })
    if (!authIsCurrent(epoch)) return false
    const nativeCookies = await getCasSessionCookies()
    if (!authIsCurrent(epoch)) return false
    const casCookies = String(nativeCookies?.casCookies || auth?.casCookies || '')
    const academicCookies = String(nativeCookies?.jwglxtCookies || auth?.jwglxtCookies || '')
    if (!academicCookies.trim()) return false
    if (casCookies.trim()) campus.casCookieHeader = mergeCookieHeaders(campus.casCookieHeader, casCookies)
    campus.client.setCookieHeader(academicCookies)
    const theolCookies = String(nativeCookies?.theolCookies || auth?.theolCookies || '')
    if (theolCookies.trim()) campus.theolClient.setCookieHeader(theolCookies)
    await persistSession(campus)
    return true
  } catch {
    return false
  }
}

async function restoreTheolSession(campus, epoch) {
  if (!nativeApp() || campus?.mode !== 'cas' || !campus?.client?.cookieHeader?.()) return false
  try {
    const auth = await openTheolLogin(THEOL_URLS.login, {
      cookieHeader: campus.casCookieHeader,
      academicCookieHeader: campus.client.cookieHeader(),
      theolCookieHeader: campus.theolClient.cookieHeader(),
      automaticTheol: true,
    })
    if (!authIsCurrent(epoch) || state.campus !== campus) return false
    const nativeCookies = await getCasSessionCookies()
    if (!authIsCurrent(epoch) || state.campus !== campus) return false
    const theolCookies = String(nativeCookies?.theolCookies || auth?.theolCookies || '')
    if (!theolCookies.trim()) return false
    const academicCookies = String(nativeCookies?.jwglxtCookies || auth?.jwglxtCookies || '')
    if (academicCookies.trim()) campus.client.setCookieHeader(academicCookies)
    campus.theolClient.setCookieHeader(theolCookies)
    state.theolAuthRequired = false
    state.theolError = ''
    await persistSession(campus)
    return true
  } catch {
    return false
  }
}

async function syncAll(campus) {
  return campus.adapter.sync({ domains: CORE_SYNC_DOMAINS, includeAcademicExtras: false })
}

async function syncWithAcademicRecovery(campus, epoch) {
  // CookieManager is the source of truth on Android. Refresh it before every
  // CAS sync so a renewed native session is not shadowed by an older in-memory
  // header after the app has been left open or resumed from the background.
  if (nativeApp() && campus?.mode === 'cas') await refreshNativeSessionCookies(campus)
  return syncWithRecovery({
    mode: campus?.mode,
    sync: () => syncAll(campus),
    recover: () => restoreCasSession(campus, epoch),
    onRecover: () => setLoginStatus('教务会话未建立，正在自动恢复统一身份认证…'),
  })
}

function adoptCampus(campus, result) {
  campus.username = campus.username || result?.profile?.studentId || ''
  state.campus = campus
  state.data = buildBasicData(result, campus.username)
  if (state.academicCalendarAssets.manifest?.calendar) state.data = { ...state.data, academicCalendar: state.academicCalendarAssets.manifest.calendar }
  state.theolData = { courses: [], assignments: [], notices: [] }
  state.theolLoaded.clear()
  state.theolError = ''
  // CAS is the single sign-on entry point. The native login bridge has already
  // tried the THEOL hand-off; keep the academic session usable when THEOL did
  // not issue its domain cookie yet and let the first platform read report the
  // actual state.
  state.theolAuthRequired = !String(campus?.theolClient?.cookieHeader?.() || '').trim()
  state.theolLoading = false
  state.extraLoading.clear()
  state.extraLoaded.clear()
  state.extraErrors = {}
  state.classroomSearching = false
  state.classroomQueried = false
  state.classroomError = ''
  state.classroomStatus = ''
  state.gradeDetailOpen.clear()
  state.gradeDetailPending = ''
  state.planPdfOpening = false
  state.planPdfError = ''
  if (state.planPdfUrl) URL.revokeObjectURL(state.planPdfUrl)
  state.planPdfUrl = ''
  state.error = ''
  state.viewHistory = []
  state.view = 'overview'
}

function extraDomainForView(view) {
  if (view === 'classrooms') return 'free-classroom'
  if (view === 'tools' && state.toolTab === 'plan') return 'academic-plan'
  return EXTRA_DOMAIN_BY_VIEW[view] || ''
}

function extraStatus(domain) {
  if (state.extraLoading.has(domain)) return '<div class="info-note" role="status">正在读取这个功能的数据…</div>'
  const error = state.extraErrors[domain]
  return error ? `<div class="warning-bar" role="status">${escapeHtml(error)}</div>` : ''
}

async function loadExtraDomain(domain, { force = false, gradeTerm = null } = {}) {
  if (!state.campus || !JWGLXT_ACTIVE_EXTRA_DOMAIN_NAMES.includes(domain)) return
  if (state.extraLoading.has(domain)) return
  if (!force && state.extraLoaded.has(domain)) return
  const campus = state.campus
  const epoch = authEpoch
  delete state.extraErrors[domain]
  state.extraLoading.add(domain)
  renderView()
  try {
    const result = await campus.adapter.sync({ domains: [domain], includeAcademicExtras: false, ...(gradeTerm ? { gradeTerm } : {}) })
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const outcome = result?.domainOutcomes?.[domain]
    const domainValue = result?.academicExtras?.domains?.[domain]
    if ((outcome?.status === 'failed' || outcome?.succeeded === false) && !domainValue) {
      state.extraLoaded.delete(domain)
      state.extraErrors[domain] = publicBasicError(result?.errors?.[0] || `${domain} 数据读取失败`)
      return
    }
    state.data = buildBasicData({ ...result, errors: [] }, campus.username, state.data)
    if (state.academicCalendarAssets.manifest?.calendar) state.data = { ...state.data, academicCalendar: state.academicCalendarAssets.manifest.calendar }
    state.extraLoaded.add(domain)
    if (domain === 'grade-details' && state.gradeDetailPending) {
      state.gradeDetailOpen.add(state.gradeDetailPending)
      state.gradeDetailPending = ''
    }
    if (Array.isArray(result?.errors) && result.errors.length) state.extraErrors[domain] = publicBasicError(result.errors[0])
    else if (domain === 'grade-details' && outcome?.completeness === 'partial') state.extraErrors[domain] = '成绩明细接口返回不完整，部分课程可能没有成绩组成，请重试'
  } catch (error) {
    if (authIsCurrent(epoch) && state.campus === campus) {
      state.extraLoaded.delete(domain)
      state.extraErrors[domain] = publicBasicError(error)
    }
  } finally {
    if (state.campus === campus) {
      state.extraLoading.delete(domain)
      if (authIsCurrent(epoch)) await persistSession(campus)
      renderApp()
    }
  }
}

async function openPlanPdf() {
  if (state.planPdfOpening || !state.campus) return
  const campus = state.campus
  const epoch = authEpoch
  const attachment = state.data?.academicExtras?.domains?.['academic-plan']?.attachments?.[0]
  if (!attachment?.sourceUrl) {
    state.planPdfError = '培养计划 PDF 尚未返回，请刷新后重试'
    renderView()
    return
  }
  state.planPdfOpening = true
  state.planPdfError = ''
  renderView()
  try {
    const cached = await campus.adapter.attachmentStore?.find?.(attachment.id, 'pdf')
    const result = cached?.buffer
      ? { buffer: cached.buffer }
      : await campus.client.binary(attachment.sourceUrl, { source: '培养计划 PDF' })
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const bytes = result?.buffer instanceof Uint8Array ? result.buffer : new Uint8Array(result?.buffer || [])
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('培养计划 PDF 返回内容无效')
    const dialog = document.querySelector('[data-plan-pdf-dialog]')
    const viewer = dialog?.querySelector('[data-plan-pdf-viewer]')
    if (!dialog || !viewer) throw new Error('培养计划 PDF 预览容器不可用')
    viewer.innerHTML = '<div class="pdf-viewer-empty">正在渲染培养计划 PDF…</div>'
    showPlanPdfDialog(dialog)
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve)
      else setTimeout(resolve, 0)
    })
    await renderAcademicCalendarPdf(bytes, viewer)
  } catch (error) {
    if (authIsCurrent(epoch) && state.campus === campus) state.planPdfError = publicBasicError(error)
  } finally {
    if (state.campus === campus) {
      state.planPdfOpening = false
      if (authIsCurrent(epoch) && state.planPdfError) renderView()
    }
  }
}

function showPlanPdfDialog(dialog) {
  if (!dialog) return
  try {
    if (typeof dialog.showModal === 'function') {
      dialog.showModal()
      return
    }
  } catch { /* Fall back to a normal fixed layer on partial dialog support. */ }
  dialog.classList.add('is-open')
  dialog.setAttribute('open', '')
  dialog.setAttribute('aria-modal', 'true')
}

function closePlanPdfDialog(dialog) {
  if (!dialog) return
  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close()
    return
  }
  dialog.classList.remove('is-open')
  dialog.removeAttribute('open')
  dialog.removeAttribute('aria-modal')
  if (!state.planPdfOpening) renderView()
}

const ACADEMIC_CALENDAR_PDF_TITLES = Object.freeze({
  teachingSchedule: '教学进程表',
  weeklyCalendar: '工作周历',
})

async function openAcademicCalendarPdf(key) {
  if (!ACADEMIC_CALENDAR_PDF_TITLES[key] || state.academicCalendarPdfOpening) return
  state.academicCalendarPdfOpening = key
  state.academicCalendarPdfError = ''
  renderView()
  try {
    const client = getAcademicCalendarClient()
    await client.load()
    const bytes = client.assetBuffer?.(key)
    if (!bytes?.length) throw new Error(`${ACADEMIC_CALENDAR_PDF_TITLES[key]}尚未缓存，请先检查更新`)
    const dialog = document.querySelector('[data-calendar-pdf-dialog]')
    const viewer = dialog?.querySelector('[data-calendar-pdf-viewer]')
    if (!dialog || !viewer) throw new Error('校历 PDF 预览容器不可用')
    viewer.innerHTML = `<div class="pdf-viewer-empty">正在渲染${ACADEMIC_CALENDAR_PDF_TITLES[key]}…</div>`
    showPlanPdfDialog(dialog)
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve)
      else setTimeout(resolve, 0)
    })
    await renderAcademicCalendarPdf(bytes, viewer)
  } catch (error) {
    state.academicCalendarPdfError = publicBasicError(error)
  } finally {
    state.academicCalendarPdfOpening = ''
    if (state.academicCalendarPdfError) renderView()
  }
}

function closeAcademicCalendarPdfDialog(dialog) {
  state.academicCalendarPdfOpening = ''
  state.academicCalendarPdfError = ''
  if (dialog && typeof dialog.close === 'function' && dialog.open) dialog.close()
  renderView()
}

function theolStatus() {
  if (state.theolLoading) return '<div class="info-note" role="status">正在读取课程平台数据…</div>'
  if (state.theolAuthRequired) return '<div class="info-note" role="status">课程平台尚未连接。CAS 已完成，点击连接后会继续使用同一统一身份认证会话。</div>'
  if (state.theolError) return `<div class="warning-bar" role="status">${escapeHtml(state.theolError)}</div>`
  if (!state.theolLoaded.size) return '<div class="info-note" role="status">课程平台数据按需读取，不会拖慢教务核心数据。</div>'
  return ''
}

async function loadTheolData({ force = false, domains = ['courses', 'assignments', 'notices'] } = {}) {
  if (!state.campus?.theolAdapter || state.theolLoading || state.theolAuthRequired) return
  const requested = [...new Set(domains)].filter((domain) => ['courses', 'assignments', 'notices'].includes(domain))
  if (!requested.length) return
  if (!force && requested.every((domain) => state.theolLoaded.has(domain))) return
  const campus = state.campus
  const epoch = authEpoch
  state.theolLoading = true
  state.theolError = ''
  renderView()
  try {
    await refreshNativeSessionCookies(campus)
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const result = await campus.theolAdapter.sync({ domains: requested })
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    state.theolData = {
      ...state.theolData,
      capturedAt: result.capturedAt || new Date().toISOString(),
      ...(Array.isArray(result.courses) ? { courses: result.courses } : {}),
      ...(Array.isArray(result.assignments) ? { assignments: result.assignments } : {}),
      ...(Array.isArray(result.notices) ? { notices: result.notices } : {}),
    }
    requested.forEach((domain) => {
      if (result.domainOutcomes?.[domain]?.status !== 'failed') state.theolLoaded.add(domain)
    })
    if (result.authRequired || result.errors?.some((error) => /课程平台.*(?:会话已失效|认证|登录)|会话已失效/u.test(String(error)))) {
      state.theolAuthRequired = true
    }
    if (Array.isArray(result.errors) && result.errors.length) state.theolError = publicBasicError(result.errors[0])
  } catch (error) {
    if (authIsCurrent(epoch) && state.campus === campus) {
      const message = publicBasicError(error)
      state.theolError = message
      if (/课程平台.*(?:会话已失效|认证|登录)|需要重新完成/u.test(message)) state.theolAuthRequired = true
    }
  } finally {
    if (state.campus === campus) {
      state.theolLoading = false
      if (authIsCurrent(epoch)) await persistSession(campus)
      renderApp()
    }
  }
}

async function connectTheol(event) {
  event?.preventDefault?.()
  if (!state.campus?.theolClient) {
    state.authError = '请先添加校园账号，再连接课程平台'
    renderView()
    return
  }
  if (state.authenticating) return
  const epoch = ++authEpoch
  const campus = state.campus
  state.authenticating = true
  state.authMode = 'theol'
  state.authError = ''
  renderView()
  try {
    const auth = await openTheolLogin(THEOL_URLS.login)
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const nativeCookies = await getCasSessionCookies()
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const academicCookies = String(nativeCookies?.jwglxtCookies || auth?.jwglxtCookies || '')
    const theolCookies = String(nativeCookies?.theolCookies || auth?.theolCookies || '')
    if (!theolCookies.trim()) throw new Error('课程平台统一认证未建立会话，请重试')
    if (academicCookies.trim()) campus.client.setCookieHeader(academicCookies)
    campus.theolClient.setCookieHeader(theolCookies)
    state.theolAuthRequired = false
    state.theolError = ''
    await persistSession(campus)
    state.theolLoaded.clear()
    state.theolData = { courses: [], assignments: [], notices: [] }
    state.authenticating = false
    state.authMode = ''
    await loadTheolData({ force: true })
  } catch (error) {
    if (authIsCurrent(epoch)) state.authError = publicBasicError(error)
  } finally {
    if (authIsCurrent(epoch)) {
      state.authenticating = false
      state.authMode = ''
      renderApp()
    }
  }
}

function ensureCurrentExtra() {
  const domain = extraDomainForView(state.view)
  if (domain && state.campus && !state.extraLoaded.has(domain) && !state.extraLoading.has(domain)) void loadExtraDomain(domain)
  if (state.view === 'venues' && !state.venueCatalog && !state.venueLoading) void loadVenueCatalog()
  if (state.view === 'assignments' && state.campus && !state.theolLoaded.has('assignments') && !state.theolLoading && !state.theolError && !state.theolAuthRequired) void loadTheolData()
  if (state.view === 'notices' && state.campus && !state.theolLoaded.has('notices') && !state.theolLoading && !state.theolError && !state.theolAuthRequired) void loadTheolData({ domains: ['courses', 'notices'] })
}

async function authenticateAccount({ event, mode, username = '', password = '' }) {
  event?.preventDefault?.()
  if (state.authenticating) return
  const epoch = ++authEpoch
  // An explicit login supersedes startup restoration. The stale restore
  // promise will exit through its epoch check and must not leave this flag set.
  state.restoringSession = false
  const button = event?.currentTarget?.matches?.('button')
    ? event.currentTarget
    : event?.currentTarget?.querySelector?.('[data-action="connect-api-account"]')
      || document.querySelector(`[data-action="${mode === 'api' ? 'connect-api-account' : 'connect-account'}"]`)
  state.loading = true
  state.authenticating = true
  state.authMode = mode
  state.authError = ''
  if (button) {
    button.disabled = true
    button.innerHTML = `<span>${mode === 'api' ? '正在登录教务 API' : '正在打开统一身份认证'}</span><span class="button-spinner" aria-hidden="true"></span>`
  }
  setLoginStatus(mode === 'api' ? '正在验证教务系统账号…' : '请在认证页面中输入账号和密码…')
  try {
    let auth = null
    if (mode === 'cas') {
      auth = await openCasLogin(JWGLXT_URLS.login)
      if (!authIsCurrent(epoch)) return
      const nativeCookies = await getCasSessionCookies()
      if (!authIsCurrent(epoch)) return
      auth = { ...auth, ...nativeCookies }
    }
    const campus = createCampus({
      username: auth?.username || username,
      password,
      casCookieHeader: auth?.casCookies || '',
      cookieHeader: auth?.jwglxtCookies ?? auth?.cookies ?? '',
      theolCookieHeader: auth?.theolCookies ?? '',
      mode,
    })
    if (mode === 'api') await campus.client.login()
    if (!authIsCurrent(epoch)) return
    // Persist the authenticated jars before the potentially long first sync.
    // A process death during data loading must not turn a successful login
    // into another login on the next launch.
    await persistSession(campus)
    if (!authIsCurrent(epoch)) return
    setLoginStatus('登录成功，正在读取核心教务数据…')
    const result = await syncWithAcademicRecovery(campus, epoch)
    if (!authIsCurrent(epoch)) return
    campus.username = auth?.username || result?.profile?.studentId || ''
    adoptCampus(campus, result)
    // CAS is the single sign-on entry point, but THEOL may still require its
    // own domain cookie. Keep the academic session usable and expose that
    // distinction to the task pages instead of trying the login flow again.
    state.theolAuthRequired = !String(campus.theolClient.cookieHeader?.() || '').trim()
      || Boolean(auth?.theolAuthRequired)
    await persistSession(campus)
    if (mode === 'cas') {
      if (state.theolAuthRequired) {
        setLoginStatus('教务已连接，正在自动连接课程平台…')
        const restoredTheol = await restoreTheolSession(campus, epoch)
        if (!authIsCurrent(epoch)) return
        state.theolAuthRequired = !restoredTheol
      }
      if (!state.theolAuthRequired) {
        setLoginStatus('教务已连接，正在同步课程平台…')
        // The CAS WebView performs the THEOL hand-off in the same cookie
        // session. Always test the platform once here, even if no THEOL cookie
        // was visible when the bridge returned.
        await loadTheolData({ force: true })
        if (!authIsCurrent(epoch)) return
        await persistSession(campus)
      }
    }
  } catch (loginError) {
    if (authIsCurrent(epoch)) {
      state.authError = publicBasicError(loginError)
      setLoginStatus('登录未完成')
    }
  } finally {
    if (authIsCurrent(epoch)) {
      state.loading = false
      state.authenticating = false
      state.authMode = ''
      renderApp()
    }
  }
}

async function restoreSavedSession() {
  const epoch = authEpoch
  let saved = null
  try {
    saved = await readPersistedSession()
  } catch (error) {
    if (authIsCurrent(epoch)) {
      state.restoringSession = false
      state.authError = `自动恢复登录失败：${publicBasicError(error)}。已保留本机登录会话，请重试或在设置中重新认证`
      renderApp()
    }
    return
  }
  if (!authIsCurrent(epoch)) return
  const nativeCookies = await getCasSessionCookies().catch(() => ({}))
  if (!authIsCurrent(epoch)) return
  const nativeAcademic = String(nativeCookies?.jwglxtCookies || '')
  const nativeCas = String(nativeCookies?.casCookies || '')
  const nativeTheol = String(nativeCookies?.theolCookies || '')
  if (saved) {
    saved = {
      ...saved,
      casCookieHeader: mergeCookieHeaders(saved.casCookieHeader, nativeCas),
      cookieHeader: mergeCookieHeaders(saved.cookieHeader, nativeAcademic),
      theolCookieHeader: mergeCookieHeaders(saved.theolCookieHeader, nativeTheol),
    }
  } else if (nativeAcademic.trim() || nativeTheol.trim()) {
    saved = {
      username: '',
      mode: 'cas',
      casCookieHeader: nativeCas,
      cookieHeader: nativeAcademic,
      theolCookieHeader: nativeTheol,
    }
  }
  if (!saved) {
    if (!authIsCurrent(epoch)) return
    state.restoringSession = false
    renderApp()
    return
  }
  try {
    const campus = createCampus(saved)
    setLoginStatus('正在恢复已保存的校园会话…')
    const result = await syncWithAcademicRecovery(campus, epoch)
    if (!authIsCurrent(epoch)) return
    adoptCampus(campus, result)
    // API sessions do not imply a THEOL session. Keep the platform action
    // gated until its own host cookie has actually been restored.
    state.theolAuthRequired = saved.mode === 'api'
      ? !String(campus.theolClient.cookieHeader?.() || '').trim()
      : false
    await persistSession(campus)
    if (saved.mode === 'cas') {
      let theolReady = Boolean(String(saved.theolCookieHeader || '').trim())
      if (!theolReady) {
        setLoginStatus('教务已恢复，正在自动连接课程平台…')
        theolReady = await restoreTheolSession(campus, epoch)
        if (!authIsCurrent(epoch)) return
      }
      if (theolReady) {
        setLoginStatus('教务已恢复，正在同步课程平台…')
        await loadTheolData({ force: true })
        if (!authIsCurrent(epoch)) return
        // A stored THEOL cookie can expire independently of the CAS session.
        // Refresh the SSO hand-off once before exposing a manual connect action.
        if (state.theolAuthRequired) {
          state.theolAuthRequired = false
          setLoginStatus('课程平台会话已更新，正在重试…')
          theolReady = await restoreTheolSession(campus, epoch)
          if (!authIsCurrent(epoch)) return
          if (theolReady) await loadTheolData({ force: true })
        }
        if (!theolReady) state.theolAuthRequired = true
        await persistSession(campus)
      } else {
        state.theolAuthRequired = true
      }
    }
  } catch (error) {
    const message = publicBasicError(error)
    const expired = /需要重新完成|会话已失效|登录/u.test(message)
    if (authIsCurrent(epoch)) {
      // Never delete the encrypted snapshot because of a transient network or
      // parser failure. An actually expired session can be replaced explicitly
      // from Settings, while a temporary failure remains recoverable.
      state.authError = expired ? '保存的校园会话暂时无法通过认证，请检查网络后重试或在设置中重新认证' : `自动恢复登录失败：${message}`
    }
  } finally {
    if (authIsCurrent(epoch)) {
      state.restoringSession = false
      renderApp()
    }
  }
}

async function connectAccount(event) {
  return authenticateAccount({ event, mode: 'cas' })
}

async function connectApiAccount(event) {
  event?.preventDefault?.()
  const form = event?.currentTarget?.closest('form')
  const username = String(form?.querySelector('[name="api-username"]')?.value || '').trim()
  const password = String(form?.querySelector('[name="api-password"]')?.value || '')
  state.apiUsername = username
  if (!username || !password) {
    state.authError = '请输入教务系统账号和密码'
    renderView()
    return
  }
  return authenticateAccount({ event, mode: 'api', username, password })
}

function navButton([id, label, icon]) {
  return `<button type="button" class="nav-button ${state.view === id ? 'is-active' : ''}" data-view="${id}" title="${label}"><span class="nav-symbol" aria-hidden="true">${icon}</span><span>${label}</span></button>`
}

function sideNavigation() {
  return `${PRIMARY_NAV.map(navButton).join('')}<span class="nav-heading">工具与设置</span>${TOOL_NAV.map(navButton).join('')}`
}

function mobileNavigation() {
  return MOBILE_NAV.map(navButton).join('')
}

function renderApp() {
  const data = state.data || {}
  const user = data.user || {}
  const viewLabel = [...PRIMARY_NAV, ...TOOL_NAV].find(([id]) => id === state.view)?.[1] || '总览'
  const showBack = state.view !== 'overview'
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="app-mark small">T</span><span class="brand-copy"><strong>THEIA</strong><small>basic · 校园工作区</small></span></div>
        <nav class="side-nav" aria-label="主导航">${sideNavigation()}</nav>
        <div class="sidebar-foot"><span class="connection-dot ${state.campus ? '' : 'is-offline'}"></span><span>${state.campus ? '已连接教务系统' : '未连接校园账号'}</span></div>
      </aside>
      <div class="main-column">
        <header class="topbar">
          <div class="topbar-leading">${showBack ? '<button class="back-button" type="button" data-action="go-back" aria-label="返回上一页" title="返回上一页">←</button>' : ''}<div class="topbar-context"><strong>${escapeHtml(viewLabel)}</strong><span class="topbar-term">${escapeHtml(termLabel(currentTerm(data)))}</span></div></div>
          <div class="topbar-user"><span class="avatar ${state.campus ? '' : 'is-guest'}">${escapeHtml(String(user.name || (state.campus ? '同学' : 'T')).slice(0, 1))}</span><span class="user-name">${escapeHtml(user.name || (state.campus ? '同学' : '未登录'))}</span>${state.campus ? '<button class="quiet-button" data-action="logout">退出</button>' : '<button class="quiet-button" data-view="settings">设置</button>'}</div>
        </header>
        <main id="view-root" class="content"></main>
        <nav class="mobile-nav" aria-label="主导航">${mobileNavigation()}</nav>
      </div>
    </div>`
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    navigateTo(button.dataset.view)
  }))
  document.querySelector('[data-action="go-back"]')?.addEventListener('click', goBack)
  document.querySelectorAll('[data-action="logout"]').forEach((button) => button.addEventListener('click', logout))
  renderView()
}

function pageHeader(kicker, title, subtitle, action = true) {
  const refreshAction = action && state.campus
  const currentExtra = extraDomainForView(state.view)
  const extraRefreshing = Boolean(currentExtra && state.extraLoading.has(currentExtra))
  const classroomBusy = state.view === 'classrooms' && state.classroomSearching
  const busy = state.refreshing || extraRefreshing || classroomBusy
  return `<div class="page-header"><div class="page-header-copy"><span class="kicker">${escapeHtml(kicker)}</span><h1>${escapeHtml(title)}</h1>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${refreshAction ? `<button class="refresh-button" data-action="refresh" ${busy ? 'disabled' : ''}><span class="refresh-symbol ${busy ? 'spin' : ''}" aria-hidden="true">↻</span><span>${busy ? '更新中' : '刷新'}</span></button>` : ''}</div>`
}

function warningBar() {
  const errors = Array.isArray(state.data?.partialErrors) ? state.data.partialErrors : []
  const message = state.error || errors[0]
  return message ? `<div class="warning-bar" role="status">${escapeHtml(message)}${errors.length > 1 ? ` <span>还有 ${errors.length - 1} 项数据读取不完整</span>` : ''}</div>` : ''
}

function searchControl(key, value, placeholder) {
  return `<label class="search-control"><span aria-hidden="true">⌕</span><input type="search" data-filter-key="${escapeHtml(key)}" value="${escapeHtml(value || '')}" placeholder="${escapeHtml(placeholder)}" aria-label="${escapeHtml(placeholder)}"></label>`
}

function filterBar(content) {
  return `<div class="filter-bar">${content}</div>`
}

function renderView() {
  const root = document.querySelector('#view-root')
  if (!root) return
  const renderers = {
    overview: renderOverview,
    map: renderMap,
    schedule: renderSchedule,
    courses: renderCourses,
    assignments: renderAssignments,
    records: renderRecords,
    progress: renderProgress,
    plan: renderPlan,
    notices: renderNotices,
    tools: renderToolsPage,
    classrooms: renderClassrooms,
    venues: renderVenues,
    settings: renderSettings,
  }
  root.innerHTML = (renderers[state.view] || renderOverview)()
  if (state.view === 'tools' && state.toolTab === 'calendar') {
    root.querySelector('.study-tools-tabs')?.insertAdjacentHTML('afterend', renderCalendarReference())
  }
  root.querySelector('[data-action="refresh"]')?.addEventListener('click', refresh)
  root.querySelector('[data-action="refresh-theol"]')?.addEventListener('click', () => {
    const domains = state.view === 'assignments' ? ['courses', 'assignments'] : ['courses', 'notices']
    void loadTheolData({ force: true, domains })
  })
  root.querySelector('[data-action="classroom-search"]')?.addEventListener('click', searchClassrooms)
  root.querySelector('[data-action="refresh-venues"]')?.addEventListener('click', () => void loadVenueCatalog(true))
  root.querySelector('[data-action="refresh-academic-calendar"]')?.addEventListener('click', () => void loadAcademicCalendarAssets(true))
  root.querySelector('[data-action="venue-query"]')?.addEventListener('click', queryVenueStatus)
  root.querySelectorAll('[data-map-poster]').forEach((poster) => poster.addEventListener('error', () => handleMapPosterError(poster)))
  root.querySelector('[data-venue-campus]')?.addEventListener('change', (event) => {
    state.venueCampus = event.target.value
    state.venueId = venueListForCampus(state.venueCatalog, state.venueCampus)[0]?.id || ''
    state.venueResult = null
    state.venueError = ''
    renderView()
  })
  root.querySelector('[data-venue-id]')?.addEventListener('change', (event) => {
    state.venueId = event.target.value
    state.venueResult = null
    state.venueError = ''
    renderView()
  })
  root.querySelector('[data-venue-date]')?.addEventListener('change', (event) => {
    state.venueDate = event.target.value
  })
  root.querySelectorAll('[data-grade-detail]').forEach((button) => button.addEventListener('click', () => toggleGradeDetail(button.dataset.gradeDetail)))
  root.querySelectorAll('[data-schedule-detail]').forEach((button) => button.addEventListener('click', () => openScheduleDetail(button.dataset.scheduleDetail)))
  root.querySelectorAll('[data-schedule-group]').forEach((button) => button.addEventListener('click', () => openScheduleGroup(button.dataset.scheduleGroup)))
  const scheduleDialog = root.querySelector('[data-schedule-dialog]')
  root.querySelector('[data-action="close-schedule-detail"]')?.addEventListener('click', () => closeScheduleDetail())
  scheduleDialog?.addEventListener('click', (event) => {
    if (event.target === scheduleDialog) closeScheduleDetail()
  })
  scheduleDialog?.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeScheduleDetail()
  })
  if (state.view === 'schedule' && (state.scheduleDetailOpen || state.scheduleGroupOpen) && scheduleDialog && !scheduleDialog.open) {
    scheduleDialog.showModal?.()
  }
  root.querySelectorAll('[data-calendar-week-detail]').forEach((button) => button.addEventListener('click', () => openCalendarWeekDetail(button.dataset.calendarWeekDetail)))
  const calendarWeekDialog = root.querySelector('[data-calendar-week-dialog]')
  root.querySelector('[data-action="close-calendar-week-detail"]')?.addEventListener('click', () => closeCalendarWeekDetail())
  calendarWeekDialog?.addEventListener('click', (event) => {
    if (event.target === calendarWeekDialog) closeCalendarWeekDetail()
  })
  calendarWeekDialog?.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeCalendarWeekDetail()
  })
  if (state.view === 'tools' && state.toolTab === 'calendar' && state.calendarWeekDetailOpen && calendarWeekDialog && !calendarWeekDialog.open) {
    calendarWeekDialog.showModal?.()
  }
  const calendarDialog = root.querySelector('[data-calendar-dialog]')
  root.querySelector('[data-action="open-calendar-image"]')?.addEventListener('click', () => calendarDialog?.showModal?.())
  root.querySelector('[data-action="close-calendar-image"]')?.addEventListener('click', () => calendarDialog?.close?.())
  calendarDialog?.addEventListener('click', (event) => {
    if (event.target === calendarDialog) calendarDialog.close()
  })
  root.querySelectorAll('[data-calendar-pdf-key]').forEach((button) => button.addEventListener('click', () => void openAcademicCalendarPdf(button.dataset.calendarPdfKey)))
  const calendarPdfDialog = root.querySelector('[data-calendar-pdf-dialog]')
  root.querySelector('[data-action="close-calendar-pdf"]')?.addEventListener('click', () => closeAcademicCalendarPdfDialog(calendarPdfDialog))
  calendarPdfDialog?.addEventListener('click', (event) => {
    if (event.target === calendarPdfDialog) closeAcademicCalendarPdfDialog(calendarPdfDialog)
  })
  calendarPdfDialog?.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeAcademicCalendarPdfDialog(calendarPdfDialog)
  })
  const planPdfDialog = root.querySelector('[data-plan-pdf-dialog]')
  root.querySelector('[data-action="open-plan-pdf"]')?.addEventListener('click', openPlanPdf)
  root.querySelector('[data-action="close-plan-pdf"]')?.addEventListener('click', () => closePlanPdfDialog(planPdfDialog))
  planPdfDialog?.addEventListener('click', (event) => {
    if (event.target === planPdfDialog) closePlanPdfDialog(planPdfDialog)
  })
  planPdfDialog?.addEventListener('close', () => {
    if (!state.planPdfOpening) renderView()
  })
  root.querySelectorAll('[data-action="connect-account"]').forEach((button) => button.addEventListener('click', connectAccount))
  root.querySelectorAll('[data-action="connect-theol"]').forEach((button) => button.addEventListener('click', connectTheol))
  root.querySelectorAll('[data-auth-form="api"]').forEach((form) => form.addEventListener('submit', connectApiAccount))
  root.querySelectorAll('[data-schedule-mode]').forEach((button) => button.addEventListener('click', () => {
    state.filters.scheduleMode = button.dataset.scheduleMode
    renderView()
  }))
  root.querySelectorAll('[data-assignment-mode]').forEach((button) => button.addEventListener('click', () => {
    state.filters.assignmentMode = button.dataset.assignmentMode || 'pending'
    renderView()
  }))
  root.querySelectorAll('[data-record-tab]').forEach((button) => button.addEventListener('click', () => {
    state.recordsTab = button.dataset.recordTab === 'exams' ? 'exams' : 'grades'
    if (button.dataset.view) navigateTo(button.dataset.view)
    else renderView()
  }))
  root.querySelectorAll('[data-tool-tab]').forEach((button) => button.addEventListener('click', () => {
    state.toolTab = ['analysis', 'plan'].includes(button.dataset.toolTab) ? button.dataset.toolTab : 'calendar'
    state.calendarWeekDetailOpen = ''
    renderView()
  }))
  root.querySelector('[data-action="tool-today"]')?.addEventListener('click', () => {
    const today = new Date()
    state.filters.toolDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    renderView()
  })
  root.querySelectorAll('[data-map-scope]').forEach((button) => button.addEventListener('click', () => {
    const scope = button.dataset.mapScope
    if (!MAP_SOURCES[scope]) return
    state.map.scope = scope
    state.map.floor = 1
    state.map.layer = 'campus'
    state.map.zoom = 1
    state.map.x = 0
    state.map.y = 0
    state.map.hiresActive = false
    renderView()
  }))
  root.querySelectorAll('[data-map-layer]').forEach((button) => button.addEventListener('click', () => {
    state.map.layer = button.dataset.mapLayer === 'satellite' ? 'satellite' : 'campus'
    state.map.hiresActive = false
    state.map.zoom = 1
    state.map.x = 0
    state.map.y = 0
    renderView()
  }))
  root.querySelector('[data-map-floor]')?.addEventListener('change', (event) => {
    state.map.floor = Math.max(1, Math.min(5, Number(event.target.value) || 1))
    state.map.zoom = 1
    state.map.x = 0
    state.map.y = 0
    state.map.hiresActive = false
    renderView()
  })
  root.querySelector('[data-map-zoom-in]')?.addEventListener('click', () => updateMapZoom(1.25))
  root.querySelector('[data-map-zoom-out]')?.addEventListener('click', () => updateMapZoom(0.8))
  root.querySelector('[data-map-reset]')?.addEventListener('click', resetMapView)
  bindMapGestures()
  if (state.view === 'map') {
    applyMapTransform()
    scheduleMapLayoutPass()
  }
  root.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    navigateTo(button.dataset.view)
  }))
  root.querySelectorAll('[data-filter-key]').forEach((control) => {
    const eventName = control.matches('input[type="search"]') ? 'input' : 'change'
    control.addEventListener(eventName, () => updateFilter(control))
  })
  root.querySelectorAll('[data-free-input]').forEach((input) => input.addEventListener('input', () => {
    state.filters[input.dataset.freeInput] = input.value
  }))
  ensureCurrentExtra()
}

function updateFilter(control) {
  const key = control.dataset.filterKey
  if (!key) return
  state.filters[key] = control.value
  if (key === 'scheduleYear' || key === 'scheduleSemester') state.filters.scheduleWeek = ''
  if (key === 'gradeYear' || key === 'gradeSemester') {
    state.extraLoaded.delete('grade-details')
    delete state.extraErrors['grade-details']
    state.gradeDetailOpen.clear()
    state.gradeDetailPending = ''
  }
  if (control.matches('input[type="search"]')) {
    clearTimeout(filterTimer)
    const activeView = state.view
    const selection = control.selectionStart
    filterTimer = setTimeout(() => {
      if (state.view !== activeView) return
      renderView()
      const next = document.querySelector(`[data-filter-key="${key}"]`)
      if (next) {
        next.focus()
        try { next.setSelectionRange(selection, selection) } catch { /* some Android inputs reject selection ranges */ }
      }
    }, 120)
    return
  }
  renderView()
}

function renderOverview() {
  const data = state.data || {}
  const user = data.user || {}
  if (!state.campus) {
    return `<section class="page-section">
      ${pageHeader('概览', 'THEIA-Android', '先浏览界面，账号连接放在设置中。', false)}
      ${state.restoringSession ? '<div class="info-note" role="status">正在恢复已保存的校园会话…</div>' : state.authError ? `<div class="warning-bar" role="status">${escapeHtml(state.authError)}</div>` : ''}
       <section class="guest-panel">
         <div class="guest-panel-mark" aria-hidden="true">T</div>
         <div class="guest-panel-copy"><span class="kicker">教务账号</span><h2>把校园信息，放在一个安静的工作区</h2><p>连接后读取课表、考试、成绩和其他只读教务信息。你可以在设置中选择 CAS 统一身份认证或教务 API。</p></div>
         <div class="guest-panel-action"><span>只读连接 · 本地保留</span><button class="primary-button" data-view="settings"><span>添加校园账号</span><span aria-hidden="true">→</span></button></div>
       </section>
      <div class="stats-grid guest-stats">
        <div class="stat"><span>今日课程</span><strong>—</strong><small>连接账号后显示</small></div>
        <div class="stat"><span>待考安排</span><strong>—</strong><small>连接账号后显示</small></div>
        <div class="stat"><span>平均绩点</span><strong>—</strong><small>连接账号后显示</small></div>
        <div class="stat"><span>数据状态</span><strong>离线</strong><small>本地界面可用</small></div>
      </div>
      <section class="guest-preview">
        <div class="guest-preview-heading"><div><span class="kicker">现在就能浏览</span><h2>先熟悉你的校园工作区</h2></div><span>无需登录</span></div>
        <div class="guest-preview-grid">
          <button type="button" class="guest-preview-item" data-view="schedule"><span class="guest-preview-icon" aria-hidden="true">▦</span><span><strong>课表视图</strong><small>按周查看课程安排</small></span><b aria-hidden="true">→</b></button>
          <button type="button" class="guest-preview-item" data-view="map"><span class="guest-preview-icon" aria-hidden="true">⌖</span><span><strong>校园地图</strong><small>浏览校园与教学楼</small></span><b aria-hidden="true">→</b></button>
          <button type="button" class="guest-preview-item" data-view="settings"><span class="guest-preview-icon" aria-hidden="true">⚙</span><span><strong>连接账号</strong><small>开始读取你的数据</small></span><b aria-hidden="true">→</b></button>
        </div>
      </section>
    </section>`
  }
  const homeTerm = currentTerm(data)
  const schedule = itemsForTerm(data.schedule, homeTerm)
  const today = new Date().getDay() || 7
  const calendarWeek = currentWeekForTerm(homeTerm, data.academicCalendar || OFFICIAL_ACADEMIC_CALENDAR)
  const currentWeekItems = calendarWeek?.week
    ? schedule.filter((item) => occursInWeek(item.weeks, calendarWeek.week))
    : []
  // Once the calendar identifies the current week, an empty week is a real
  // result. Falling back to the whole term here makes old courses appear on
  // the home page, especially when the current term has no classes today.
  const visibleSchedule = calendarWeek?.week ? currentWeekItems : schedule
  const todayItems = visibleSchedule.filter((item) => Number(item.weekday) === today)
  const exams = examItems(data)
  const grades = (Array.isArray(data.grades) ? data.grades : []).slice().sort(compareGradesByRecency)
  const extras = data.academicExtras?.domains || {}
  const plan = data.academicProgress
  const previewSchedule = (todayItems.length ? todayItems : visibleSchedule)
    .slice()
    .sort((left, right) => Number(left.weekday || 99) - Number(right.weekday || 99) || String(left.period || '').localeCompare(String(right.period || ''), 'zh-CN'))
    .slice(0, 4)
  return `<section class="page-section">
    ${pageHeader('概览', `你好，${user.name || '同学'}`, `${termLabel(currentTerm(data))} · 最近更新 ${dateTimeLabel(data.updatedAt)}`)}
    ${warningBar()}
    <div class="stats-grid">
      <div class="stat"><span>今日课程</span><strong>${todayItems.length}</strong><small>${todayItems.length ? `周${DAYS[today - 1]}` : '今天没有课程'}</small></div>
      <div class="stat"><span>待考安排</span><strong>${exams.length}</strong><small>${data.exams?.length || 0} 条历史记录</small></div>
      <div class="stat"><span>平均绩点</span><strong>${escapeHtml(data.user?.gpa ?? plan?.gpa ?? '—')}</strong><small>教务系统数据</small></div>
      <div class="stat"><span>实用数据域</span><strong>${Object.keys(extras).length + 5}</strong><small>已读取基础与扩展信息</small></div>
    </div>
    <div class="quick-tools"><div class="section-title compact"><div><span class="kicker">全部功能</span><h2>常用工具</h2></div></div><div class="quick-tool-grid">${OVERVIEW_TOOL_NAV.map(([id, label, icon]) => `<button class="quick-tool" data-view="${id}"><span class="quick-tool-icon" aria-hidden="true">${icon}</span><span>${label}</span><small>${toolCount(id, data)}</small></button>`).join('')}</div></div>
    <div class="overview-grid">
      <section class="surface-section"><div class="section-title"><div><span class="kicker">${todayItems.length ? `周${DAYS[today - 1]}` : '近期'}</span><h2>课表</h2></div><button class="text-link" data-view="schedule">查看全部 <span aria-hidden="true">→</span></button></div><div class="item-list">${previewSchedule.length ? previewSchedule.map(scheduleItem).join('') : emptyState('暂无课表数据')}</div></section>
      <section class="surface-section"><div class="section-title"><div><span class="kicker">接下来</span><h2>考试</h2></div><button class="text-link" data-view="records" data-record-tab="exams">查看全部 <span aria-hidden="true">→</span></button></div><div class="item-list">${exams.slice(0, 3).map(examItem).join('') || emptyState('暂无考试安排')}</div><div class="section-title secondary"><div><span class="kicker">最近发布</span><h2>成绩</h2></div><button class="text-link" data-view="records" data-record-tab="grades">查看全部 <span aria-hidden="true">→</span></button></div><div class="item-list">${grades.slice(0, 3).map(gradeItem).join('') || emptyState('暂无成绩记录')}</div></section>
    </div>
  </section>`
}

function currentMapSource() {
  if (state.map.scope === 'campus') return MAP_SOURCES[state.map.layer === 'satellite' ? 'satellite' : 'campus']
  return MAP_SOURCES[state.map.scope]?.[state.map.floor] || MAP_SOURCES.campus
}

function mapTransform() {
  const zoom = Number(state.map.zoom) || 1
  const x = Number(state.map.x) || 0
  const y = Number(state.map.y) || 0
  return `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${zoom})`
}

function mapCanvasSize(image, stage) {
  if (!image || !stage) return null
  const width = Number(image.dataset.mapNaturalWidth) || 1
  const height = Number(image.dataset.mapNaturalHeight) || 1
  const rect = stage.getBoundingClientRect()
  const stageWidth = rect.width || stage.clientWidth || 0
  const stageHeight = rect.height || stage.clientHeight || 0
  // The map is rendered immediately after innerHTML is replaced. On older
  // WebViews the first layout pass can still report zero; leave the CSS
  // poster visible and let the scheduled pass calculate exact pixels.
  if (stageWidth < 2 || stageHeight < 2) return null
  const availableWidth = Math.max(1, stageWidth - 24)
  const availableHeight = Math.max(1, stageHeight - 24)
  const fitScale = Math.min(availableWidth / width, availableHeight / height)
  const displayWidth = Math.max(1, Math.round(width * fitScale))
  const displayHeight = Math.max(1, Math.round(height * fitScale))
  image.dataset.mapDisplayWidth = String(displayWidth)
  image.dataset.mapDisplayHeight = String(displayHeight)
  image.style.width = `${displayWidth}px`
  image.style.height = `${displayHeight}px`
  return { width, height, displayWidth, displayHeight, stageWidth, stageHeight }
}

function mapTileUrl(source, column, row) {
  const tiles = source?.tiles
  if (!tiles) return ''
  return assetUrl(`maps/${tiles.directory}/tile-${column}-${row}.${tiles.extension}`)
}

function mapVisibleTileKeys(image, stage, source) {
  const tiles = source?.tiles
  if (!image || !stage || !tiles) return []
  const displayWidth = Number(image.dataset.mapDisplayWidth) || 1
  const displayHeight = Number(image.dataset.mapDisplayHeight) || 1
  const zoom = Math.max(1, Number(state.map.zoom) || 1)
  const rect = stage.getBoundingClientRect()
  const localLeft = Math.max(0, Math.min(displayWidth, displayWidth / 2 + (-rect.width / 2 - (Number(state.map.x) || 0)) / zoom))
  const localRight = Math.max(0, Math.min(displayWidth, displayWidth / 2 + (rect.width / 2 - (Number(state.map.x) || 0)) / zoom))
  const localTop = Math.max(0, Math.min(displayHeight, displayHeight / 2 + (-rect.height / 2 - (Number(state.map.y) || 0)) / zoom))
  const localBottom = Math.max(0, Math.min(displayHeight, displayHeight / 2 + (rect.height / 2 - (Number(state.map.y) || 0)) / zoom))
  const left = Math.floor(Math.min(localLeft, localRight) / displayWidth * tiles.columns)
  const right = Math.floor(Math.max(localLeft, localRight) / displayWidth * tiles.columns)
  const top = Math.floor(Math.min(localTop, localBottom) / displayHeight * tiles.rows)
  const bottom = Math.floor(Math.max(localTop, localBottom) / displayHeight * tiles.rows)
  const centerColumn = (left + right) / 2
  const centerRow = (top + bottom) / 2
  const candidates = []
  for (let row = Math.max(0, top - 1); row <= Math.min(tiles.rows - 1, bottom + 1); row += 1) {
    for (let column = Math.max(0, left - 1); column <= Math.min(tiles.columns - 1, right + 1); column += 1) {
      candidates.push({ column, row, key: `${column}-${row}`, distance: Math.abs(column - centerColumn) + Math.abs(row - centerRow) })
    }
  }
  return candidates.sort((leftItem, rightItem) => leftItem.distance - rightItem.distance).slice(0, MAP_HIGH_RES_TILE_LIMIT)
}

function loadMapTiles(image) {
  if (!image) return
  if (state.view !== 'map' || (Number(state.map.zoom) || 1) < MAP_HIGH_RES_ZOOM) return
  const source = currentMapSource()
  const stage = image.closest('[data-map-stage]')
  const layer = image.querySelector('[data-map-tile-layer]')
  if (!source?.tiles || !stage || !layer) return
  const visible = mapVisibleTileKeys(image, stage, source)
  const wanted = new Set(visible.map((tile) => tile.key))
  layer.querySelectorAll('[data-map-tile-key]').forEach((tile) => {
    if (!wanted.has(tile.dataset.mapTileKey)) tile.remove()
  })
  for (const tile of visible) {
    if (layer.querySelector(`[data-map-tile-key="${tile.key}"]`)) continue
    const imageTile = document.createElement('img')
    imageTile.className = 'map-tile'
    imageTile.dataset.mapTileKey = tile.key
    imageTile.alt = ''
    imageTile.draggable = false
    imageTile.decoding = 'async'
    imageTile.loading = 'eager'
    imageTile.style.gridColumn = String(tile.column + 1)
    imageTile.style.gridRow = String(tile.row + 1)
    imageTile.addEventListener('load', () => imageTile.classList.add('is-loaded'), { once: true })
    imageTile.addEventListener('error', () => imageTile.remove(), { once: true })
    layer.appendChild(imageTile)
    imageTile.src = mapTileUrl(source, tile.column, tile.row)
  }
}

function handleMapPosterError(poster) {
  if (!poster || poster.dataset.mapFallbackApplied === 'true') return
  const fallback = String(poster.dataset.mapFallback || '')
  if (!fallback) {
    poster.classList.add('is-broken')
    return
  }
  poster.dataset.mapFallbackApplied = 'true'
  poster.src = fallback
}

function applyMapTransform() {
  const image = document.querySelector('[data-map-image]')
  const stage = document.querySelector('[data-map-stage]')
  const hiresActive = (Number(state.map.zoom) || 1) >= MAP_HIGH_RES_ZOOM
  state.map.hiresActive = hiresActive
  if (image) {
    mapCanvasSize(image, stage)
    image.style.transform = mapTransform()
  }
  const zoomLabel = document.querySelector('[data-map-zoom-label]')
  if (zoomLabel) zoomLabel.textContent = `${Math.round((Number(state.map.zoom) || 1) * 100)}%`
  if (hiresActive) loadMapTiles(image)
  else {
    const layer = image?.querySelector('[data-map-tile-layer]')
    while (layer?.firstChild) layer.removeChild(layer.firstChild)
  }
}

function scheduleMapLayoutPass() {
  if (state.view !== 'map') return
  const run = () => {
    if (state.view === 'map') applyMapTransform()
  }
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(run)
  else setTimeout(run, 0)
  // A second pass covers Android WebView's delayed grid measurement after a
  // navigation or an orientation change without keeping a permanent timer.
  setTimeout(run, 80)
}

function updateMapZoom(factor) {
  if (state.view !== 'map') return
  state.map.zoom = Math.max(1, Math.min(5, (Number(state.map.zoom) || 1) * factor))
  state.map.hiresActive = state.map.zoom >= MAP_HIGH_RES_ZOOM
  applyMapTransform()
}

function resetMapView() {
  state.map.zoom = 1
  state.map.x = 0
  state.map.y = 0
  state.map.hiresActive = false
  applyMapTransform()
}

function bindMapGestures() {
  const stage = document.querySelector('[data-map-stage]')
  if (!stage) return
  const pointers = new Map()
  let singlePointer = null
  let pinch = null
  const centerOf = () => {
    const values = [...pointers.values()]
    const center = values.reduce((result, pointer) => ({ x: result.x + pointer.x, y: result.y + pointer.y }), { x: 0, y: 0 })
    return { x: center.x / values.length, y: center.y / values.length }
  }
  const distanceOf = () => {
    const values = [...pointers.values()]
    if (values.length < 2) return 0
    return Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y)
  }
  const finish = (event) => {
    pointers.delete(event.pointerId)
    if (stage.hasPointerCapture?.(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    if (pointers.size >= 2) {
      pinch = { center: centerOf(), distance: distanceOf() }
      singlePointer = null
      return
    }
    if (pointers.size === 1) {
      const [pointer] = pointers.values()
      singlePointer = { x: pointer.x, y: pointer.y }
      pinch = null
      return
    }
    singlePointer = null
    pinch = null
    stage.classList.remove('is-dragging')
  }
  stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, select')) return
    event.preventDefault()
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    stage.setPointerCapture?.(event.pointerId)
    if (pointers.size === 1) singlePointer = { x: event.clientX, y: event.clientY }
    if (pointers.size === 2) {
      pinch = { center: centerOf(), distance: distanceOf() }
      singlePointer = null
    }
    stage.classList.add('is-dragging')
  })
  stage.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    event.preventDefault()
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.size >= 2) {
      const center = centerOf()
      const distance = distanceOf()
      const rect = stage.getBoundingClientRect()
      const previousZoom = Number(state.map.zoom) || 1
      const nextZoom = Math.max(1, Math.min(5, previousZoom * (pinch?.distance ? distance / pinch.distance : 1)))
      const zoomRatio = nextZoom / previousZoom
      state.map.x += center.x - (pinch?.center?.x || center.x)
      state.map.y += center.y - (pinch?.center?.y || center.y)
      state.map.x += (1 - zoomRatio) * (center.x - (rect.left + rect.width / 2) - state.map.x)
       state.map.y += (1 - zoomRatio) * (center.y - (rect.top + rect.height / 2) - state.map.y)
       state.map.zoom = nextZoom
       state.map.hiresActive = state.map.zoom >= MAP_HIGH_RES_ZOOM
       pinch = { center, distance }
    } else if (singlePointer) {
      state.map.x += event.clientX - singlePointer.x
      state.map.y += event.clientY - singlePointer.y
      singlePointer = { x: event.clientX, y: event.clientY }
    }
    applyMapTransform()
  })
  stage.addEventListener('pointerup', finish)
  stage.addEventListener('pointercancel', finish)
  stage.addEventListener('wheel', (event) => {
    event.preventDefault()
    updateMapZoom(event.deltaY < 0 ? 1.15 : 0.87)
  }, { passive: false })
  stage.addEventListener('dblclick', () => updateMapZoom(1.5))
}

function mapTileMarkup(source) {
  const mobile = source.mobileSrc || source.src
  const tiles = source.tiles
  const columnTemplate = tiles.columnWidths.map((value) => `${value}fr`).join(' ')
  const rowTemplate = tiles.rowHeights.map((value) => `${value}fr`).join(' ')
  return `<div class="map-image map-tile-canvas" data-map-image data-map-natural-width="${tiles.width}" data-map-natural-height="${tiles.height}" style="--map-natural-width:${tiles.width}px;--map-natural-height:${tiles.height}px;--map-column-template:${escapeHtml(columnTemplate)};--map-row-template:${escapeHtml(rowTemplate)};--map-ratio-width:${tiles.width};--map-ratio-height:${tiles.height};transform:${mapTransform()}" role="img" aria-label="${escapeHtml(source.alt)}"><img class="map-poster" data-map-poster data-map-fallback="${escapeHtml(source.src)}" src="${escapeHtml(mobile)}" alt="${escapeHtml(source.alt)}" draggable="false" decoding="async" loading="eager"><div class="map-tile-layer" data-map-tile-layer aria-hidden="true"></div></div>`
}

function renderMap() {
  const source = currentMapSource()
  const scope = state.map.scope
  const buildingLabel = scope === 'first' ? '第一教学楼' : scope === 'second' ? '第二教学楼' : '昌平校区'
  const floorOptions = scope === 'campus' ? '' : `<label class="map-floor-select"><span>楼层</span><select class="control-select" data-map-floor>${Array.from({ length: 5 }, (_value, index) => `<option value="${index + 1}" ${state.map.floor === index + 1 ? 'selected' : ''}>${index + 1} 层</option>`).join('')}</select></label>`
  const layerControls = scope === 'campus' ? `<div class="segmented" role="group" aria-label="底图类型"><button type="button" data-map-layer="campus" class="${state.map.layer === 'campus' ? 'is-active' : ''}">校园图</button><button type="button" data-map-layer="satellite" class="${state.map.layer === 'satellite' ? 'is-active' : ''}">卫星图</button></div>` : ''
  const image = mapTileMarkup(source)
  return `<section class="page-section map-page"><section class="surface-section map-panel"><div class="map-toolbar"><div class="map-scope-controls" role="group" aria-label="地图范围"><button type="button" data-map-scope="campus" class="${scope === 'campus' ? 'is-active' : ''}">校园</button><button type="button" data-map-scope="first" class="${scope === 'first' ? 'is-active' : ''}">一教</button><button type="button" data-map-scope="second" class="${scope === 'second' ? 'is-active' : ''}">二教</button></div>${floorOptions}${layerControls}</div><div class="map-stage" data-map-stage tabindex="0" aria-label="${escapeHtml(source.title)}互动地图">${image}<div class="map-controls"><div class="map-zoom-label" data-map-zoom-label>${Math.round((Number(state.map.zoom) || 1) * 100)}%</div><div class="map-zoom-buttons"><button type="button" data-map-zoom-out aria-label="缩小地图" title="缩小">−</button><button type="button" data-map-reset aria-label="重置地图视图" title="重置">⌂</button><button type="button" data-map-zoom-in aria-label="放大地图" title="放大">+</button></div></div><span class="map-gesture-note">${buildingLabel} · 拖动查看 · 双指缩放</span></div><div class="map-caption"><strong>${escapeHtml(source.title)}</strong><span>${scope === 'campus' ? '昌平校区教学区域' : `${buildingLabel}室内平面图 · ${state.map.floor} 层`}</span></div></section></section>`
}

function toolCount(id, data) {
  if (id === 'map') return '校园与楼层'
  if (id === 'settings') return state.campus ? '已连接' : '未连接'
  if (id === 'assignments') return state.theolLoaded.has('assignments') ? `${state.theolData.assignments.length} 项` : '按需读取'
  if (id === 'progress') return data.academicProgress ? '已读取' : '待读取'
  if (id === 'notices') return `${data.notices?.length || 0} 条`
  if (id === 'classrooms') return '实时查询'
  if (id === 'venues') return state.venueCatalog ? `${state.venueCatalog.counts?.venues || 0} 个` : '公开查询'
  const domain = EXTRA_DOMAIN_BY_VIEW[id]
  return `${data.academicExtras?.domains?.[domain]?.records?.length || 0} 条`
}

function scheduleItem(item) {
  return `<div class="list-item schedule-list-item"><div class="item-time">${escapeHtml(item.period || '—')}</div><div class="item-body"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(detailLine([item.room, item.teacher, item.weeks]))}</span></div><span class="item-side">${item.weekday ? `周${DAYS[item.weekday - 1]}` : ''}</span></div>`
}

function scheduleSlotGroupKey(slot) {
  return [slot.weekday, slot.start, slot.end, slot.items.map(scheduleDetailKey).join('~')].join('|')
}

function scheduleDetailItem(data, key) {
  const wanted = String(key || '')
  if (!wanted) return null
  const items = scheduleItems(data)
  let parsed = null
  try {
    parsed = JSON.parse(wanted)
  } catch (_error) {
    parsed = null
  }
  const index = Array.isArray(parsed) && Number.isInteger(parsed[0]) ? parsed[0] : -1
  if (index >= 0 && index < items.length) {
    const item = items[index]
    if (scheduleDetailKey({ ...item, __scheduleIndex: index }) === wanted) return item
  }
  return items.find((item) => scheduleDetailKey(item) === wanted) || null
}

function openScheduleDetail(key) {
  if (!key) return
  state.scheduleDetailOpen = String(key)
  state.scheduleGroupOpen = ''
  renderView()
}

function openScheduleGroup(key) {
  if (!key) return
  state.scheduleDetailOpen = ''
  state.scheduleGroupOpen = String(key)
  renderView()
}

function closeScheduleDetail() {
  state.scheduleDetailOpen = ''
  state.scheduleGroupOpen = ''
  renderView()
}

function scheduleDetailValues(item) {
  const weekday = Number(item.weekday)
  const weekdayLabel = Number.isInteger(weekday) && weekday >= 1 && weekday <= DAYS.length ? `周${DAYS[weekday - 1]}` : '星期待定'
  return [
    ['课程名称', item.title || '未命名课程'],
    ['地点', item.room || '地点待定'],
    ['教师', item.teacher || '教师待定'],
    ['星期', weekdayLabel],
    ['节次', item.period || '节次待定'],
    ['周次', item.weeks || '周次待定'],
    ['课程代码', item.courseCode || '课程代码待定'],
    ['学期', itemTermLabel(item)],
  ]
}

function scheduleDetailDialog(item) {
  const values = scheduleDetailValues(item)
  return `<dialog class="schedule-detail-dialog" data-schedule-dialog aria-label="课程详情"><div class="schedule-detail-head"><div><span class="kicker">课程详情</span><h2>${escapeHtml(item.title || '未命名课程')}</h2></div><button type="button" class="calendar-lightbox-close" data-action="close-schedule-detail" aria-label="关闭课程详情">×</button></div><dl class="schedule-detail-grid">${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></dialog>`
}

function scheduleGroupDialog(items) {
  const first = items[0] || {}
  const weekday = Number(first.weekday)
  const weekdayLabel = Number.isInteger(weekday) && weekday >= 1 && weekday <= DAYS.length ? `周${DAYS[weekday - 1]}` : '星期待定'
  const periodLabel = first.period || '节次待定'
  const list = items.map((item, index) => `<article class="schedule-group-card"><div class="schedule-group-card-head"><span class="schedule-group-index">第 ${index + 1} 门</span><h3>${escapeHtml(item.title || '未命名课程')}</h3></div><dl class="schedule-group-detail-grid">${scheduleDetailValues(item).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></article>`).join('')
  return `<dialog class="schedule-detail-dialog schedule-group-dialog" data-schedule-dialog aria-label="同一时段的全部课程"><div class="schedule-detail-head"><div><span class="kicker">同一时段 · 全部信息</span><h2>${escapeHtml(`${weekdayLabel} · ${periodLabel}`)}</h2><p class="schedule-group-summary">共 ${items.length} 门课程，以下已展开显示每门课程的完整信息</p></div><button type="button" class="calendar-lightbox-close" data-action="close-schedule-detail" aria-label="关闭课程列表">×</button></div><div class="schedule-group-list">${list}</div></dialog>`
}

function calendarText(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim()
}

function calendarWeekDetailKey(entry) {
  return String(entry?.id || [entry?.academicYear, entry?.semesterNumber, entry?.weekStart, entry?.weekEnd, entry?.dateText, entry?.summary].map((value) => String(value || '')).join('|'))
}

function calendarIsoDateLabel(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/u)
  return match ? `${Number(match[2])}月${Number(match[3])}日` : ''
}

function calendarEntryWeekLabel(entry) {
  const raw = calendarText(entry?.weekLabel)
  if (/开学前/u.test(raw)) return raw.replace(/(开学前)\s*(\d+)\s*周/u, '$1 $2 周')
  const start = Number(entry?.weekStart)
  const end = Number(entry?.weekEnd)
  const range = Number.isInteger(start) ? `第 ${start}${Number.isInteger(end) && end !== start ? `-${end}` : ''} 周` : (raw || '周次待定')
  return entry?.semesterNumber ? `第 ${entry.semesterNumber} 学期 · ${range}` : range
}

function calendarEntryDateLabel(entry) {
  const start = calendarIsoDateLabel(entry?.startDate)
  const end = calendarIsoDateLabel(entry?.endDate)
  if (start && end) return start === end ? start : `${start} - ${end}`
  return calendarText(entry?.dateText).replace(/\s*[至到～~—–－-]\s*/gu, ' - ')
}

function calendarEntryWeekdayLabel(value) {
  const text = calendarText(value)
  const match = text.match(/^([一二三四五六日])(?:\s*[至～~—–－-]\s*([一二三四五六日]))?$/u)
  if (match) return match[2] ? `周${match[1]}至周${match[2]}` : `周${match[1]}`
  return text
}

function openCalendarWeekDetail(key) {
  if (!key) return
  state.calendarWeekDetailOpen = String(key)
  renderView()
}

function closeCalendarWeekDetail() {
  state.calendarWeekDetailOpen = ''
  renderView()
}

function calendarWeekDetailDialog(entry) {
  const values = [
    ['周次', calendarEntryWeekLabel(entry)],
    ['日期', calendarEntryDateLabel(entry) || '日期待定'],
    ['星期', calendarEntryWeekdayLabel(entry?.weekdayText) || '星期待定'],
    ['事项', entry?.summary || '事项待定'],
    ['学年', entry?.academicYear || '学年待定'],
  ]
  return `<dialog class="schedule-detail-dialog calendar-week-detail-dialog" data-calendar-week-dialog aria-label="工作周历事项详情"><div class="schedule-detail-head"><div><span class="kicker">工作周历</span><h2>${escapeHtml(entry?.summary || '事项详情')}</h2></div><button type="button" class="calendar-lightbox-close" data-action="close-calendar-week-detail" aria-label="关闭工作周历详情">×</button></div><dl class="schedule-detail-grid">${values.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl></dialog>`
}

function examItem(item) {
  const when = item.startAt || item.examTime
  return `<div class="list-item"><div class="date-block"><strong>${escapeHtml(dateLabel(when).replace(/周[一二三四五六日]/, ''))}</strong><span>${escapeHtml(dateTimeLabel(when).split(' ')[1] || '待定')}</span></div><div class="item-body"><strong>${escapeHtml(item.courseName)}</strong><span>${escapeHtml(detailLine([item.location, item.campus, item.examType, item.seat ? `座位 ${item.seat}` : '', item.remark]))}</span></div></div>`
}

function gradeItem(item) {
  return `<div class="list-item"><div class="item-body"><strong>${escapeHtml(item.courseName)}</strong><span>${escapeHtml(detailLine([item.courseCode, item.credits ? `${item.credits} 学分` : '', itemTermLabel(item)]))}</span></div><strong class="score ${item.score ? '' : 'muted'}">${escapeHtml(item.score || '—')}</strong></div>`
}

function gradeTermRank(item) {
  const termIdMatch = gradeRecordTermId(item).match(/^(\d{4})-(\d+)$/u)
  const year = numericValue(item?.academicYear) || Number(termIdMatch?.[1]) || 0
  const rawTerm = normalizedGradeTerm(recordValue(item, 'term') || termIdMatch?.[2] || '')
  const semester = { '3': 3, '12': 2, '16': 1, '1': 3, '2': 2 }[rawTerm] || numericValue(rawTerm) || 0
  return year * 10 + semester
}

function gradePublicationTime(item) {
  const publicationFields = [item?.publishedAt, item?.releaseAt, item?.publishDate, item?.publishedDate, item?.releaseDate]
  const publicationTimes = publicationFields.map((value) => dateValue(value)?.getTime() || 0).filter(Boolean)
  if (publicationTimes.length) return Math.max(...publicationTimes)
  return Math.max(0, ...[item?.updatedAt, item?.createdAt, item?.modifiedAt, item?.lastModified]
    .map((value) => dateValue(value)?.getTime() || 0))
}

function compareGradesByRecency(left, right) {
  const publishedDelta = gradePublicationTime(right) - gradePublicationTime(left)
  if (publishedDelta) return publishedDelta
  const termDelta = gradeTermRank(right) - gradeTermRank(left)
  if (termDelta) return termDelta
  return String(left?.courseName || '').localeCompare(String(right?.courseName || ''), 'zh-CN')
}

const GRADE_RECORD_KEY_ALIASES = Object.freeze({
  courseName: ['courseName', 'kcmc', '课程名称'],
  courseCode: ['courseCode', 'kch', 'kchm', '课程代码'],
  classInternalId: ['classInternalId', 'jxb_id', 'classId', '教学班ID'],
  className: ['className', 'jxbmc', 'jxb', 'class', '教学班名称', '教学班'],
  academicYear: ['academicYear', 'xnm', 'xn', '学年代码'],
  academicYearLabel: ['academicYearLabel', 'xnmmc', '学年'],
  term: ['term', 'xqm', 'xq', '学期代码'],
  termLabel: ['termLabel', 'xqmmc', '学期'],
  componentScore: ['componentScore', 'xmcj', 'assessmentDetails', '分项成绩'],
  assessmentItem: ['assessmentItem', 'xmblmc', '成绩组成'],
  overallScore: ['overallScore', 'zpcj', '总评成绩'],
})

function recordValue(record, key) {
  const keys = GRADE_RECORD_KEY_ALIASES[key] || [key]
  for (const candidate of keys) {
    const direct = record?.[candidate]
    if (direct !== undefined && direct !== null && String(direct).trim()) return String(direct)
    const field = Array.isArray(record?.fields)
      ? record.fields.find((entry) => String(entry?.name || '') === candidate || String(entry?.label || '') === candidate)
      : null
    if (field?.value !== undefined && field?.value !== null && String(field.value).trim()) return String(field.value)
  }
  return ''
}

function normalizedGradeTerm(value) {
  const text = String(value || '').trim()
  if (text === '3') return '3'
  if (text === '9') return '12'
  if (text === '12') return '12'
  if (text === '16') return '16'
  if (text === '1' || /第一/u.test(text)) return '3'
  if (text === '2' || /第二/u.test(text)) return '12'
  if (/第三/u.test(text)) return '16'
  return text
}

function normalizedGradeYear(value) {
  const text = String(value || '').trim()
  return text.match(/(?:19|20)\d{2}/u)?.[0] || gradeMatchText(text)
}

function gradeRecordTermId(record) {
  const direct = canonicalTermId(record?.termId)
  const directMatch = direct.match(/^(20\d{2})-(\d{1,2})$/u)
  const year = normalizedGradeYear(recordValue(record, 'academicYear') || recordValue(record, 'academicYearLabel') || directMatch?.[1])
  const semester = normalizedGradeTerm(recordValue(record, 'term') || recordValue(record, 'termLabel') || directMatch?.[2])
  return year && semester ? `${year}-${semester}` : direct
}

function gradeDetailMatchesTerm(record, term) {
  if (!term) return true
  const recordTermId = gradeRecordTermId(record).match(/^(\d{4})-(\d+)$/u)
  const year = recordValue(record, 'academicYear') || recordValue(record, 'academicYearLabel') || recordTermId?.[1] || ''
  const semester = normalizedGradeTerm(recordValue(record, 'term') || recordValue(record, 'termLabel') || recordTermId?.[2])
  const expectedYear = normalizedGradeYear(term.year)
  const actualYear = normalizedGradeYear(year)
  if (year && expectedYear && actualYear !== expectedYear) return false
  if (semester && normalizedGradeTerm(term.term) !== semester) return false
  return true
}

function gradeDetailRecords(domain, term) {
  const records = (Array.isArray(domain?.records) ? domain.records : []).filter((record) => {
    const type = String(record?.recordType || '')
    const hasCourse = recordValue(record, 'courseName') || recordValue(record, 'courseCode')
    const isGradeRecord = type === 'grade-course' || type.includes('component') || hasCourse
    return isGradeRecord && gradeDetailMatchesTerm(record, term)
  })
  if (records.length) return records
  // Some deployments mix a display term label and a numeric term code across
  // rows. Do not hide a complete course response just because strict term
  // matching found no rows; course matching below still limits what is shown.
  return (Array.isArray(domain?.records) ? domain.records : []).filter((record) => {
    const type = String(record?.recordType || '')
    return type === 'grade-course' || type.includes('component') || recordValue(record, 'courseName') || recordValue(record, 'courseCode')
  })
}

function gradeDetailGroups(records) {
  const groups = []
  for (const record of records) {
    const courseCode = recordValue(record, 'courseCode')
    const title = recordValue(record, 'courseName') || record.title || '未命名课程'
    const academicYear = recordValue(record, 'academicYearLabel') || recordValue(record, 'academicYear')
    const term = recordValue(record, 'termLabel') || recordValue(record, 'term')
    const normalizedCode = gradeMatchText(courseCode)
    const normalizedTitle = gradeMatchText(title)
    const classId = recordValue(record, 'classInternalId')
    const normalizedClassId = gradeMatchText(classId)
    const group = groups.find((candidate) => {
      const sameYear = !academicYear || !candidate.academicYear || normalizedGradeYear(academicYear) === normalizedGradeYear(candidate.academicYear)
      const sameTerm = !term || !candidate.term || normalizedGradeTerm(term) === normalizedGradeTerm(candidate.term)
      return sameYear && sameTerm && ((normalizedCode && candidate.courseCodes.has(normalizedCode))
        || (normalizedClassId && candidate.classIds.has(normalizedClassId))
        || (normalizedTitle && candidate.courseNames.has(normalizedTitle)))
    }) || {
      key: [courseCode || title, academicYear, term].join('|'),
      title,
      courseCode,
      academicYear,
      term,
      courseCodes: new Set(),
      courseNames: new Set(),
      classIds: new Set(),
      summary: null,
      components: [],
    }
    if (!groups.includes(group)) groups.push(group)
    if (normalizedCode) group.courseCodes.add(normalizedCode)
    if (normalizedTitle) group.courseNames.add(normalizedTitle)
    if (normalizedClassId) group.classIds.add(normalizedClassId)
    if (!group.courseCode && courseCode) group.courseCode = courseCode
    if (!group.title || group.title === '未命名课程') group.title = title
    const type = String(record?.recordType || '')
    const isComponent = type.includes('component') || Boolean(recordValue(record, 'componentScore') || recordValue(record, 'assessmentItem'))
    if (isComponent) group.components.push(record)
    else if (!group.summary || type === 'grade-course') group.summary = record
  }
  return groups.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'))
}

function gradeMatchText(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\-_（）()]+/gu, '').toUpperCase()
}

function gradeDetailFieldList(record) {
  const hidden = new Set(['studentInternalId', 'courseInternalId', 'classInternalId', 'academicYear', 'term', 'studentId'])
  return recordFields(record).filter((field) => !hidden.has(String(field.name)) && field.value != null && String(field.value).trim()).slice(0, 8)
}

function gradeDetailKey(item) {
  return String(item?.id || [recordValue(item, 'courseCode') || recordValue(item, 'courseName') || '未命名课程', item?.termId || recordValue(item, 'term')].join('|'))
}

function gradeDetailGroupForItem(item, groups) {
  const courseCode = gradeMatchText(recordValue(item, 'courseCode'))
  const courseName = gradeMatchText(recordValue(item, 'courseName'))
  const classId = gradeMatchText(recordValue(item, 'classInternalId'))
  const itemTermId = String(item?.termId || '').trim().match(/^(\d{4})-(\d+)$/u)
  const itemYear = normalizedGradeYear(recordValue(item, 'academicYear') || itemTermId?.[1])
  const itemTerm = normalizedGradeTerm(recordValue(item, 'term') || itemTermId?.[2])
  const sameTerm = (group) => {
    const groupYear = normalizedGradeYear(group?.academicYear)
    const groupTerm = normalizedGradeTerm(group?.term)
    return (!itemYear || !groupYear || itemYear === groupYear) && (!itemTerm || !groupTerm || itemTerm === groupTerm)
  }
  const exact = (predicate) => groups.find((group) => sameTerm(group) && predicate(group))
  return exact((group) => classId && group.classIds?.has(classId) && (!courseCode || group.courseCodes?.has(courseCode)))
    || exact((group) => courseCode && group.courseCodes?.has(courseCode))
    || exact((group) => courseName && group.courseNames?.has(courseName))
    || exact((group) => classId && group.classIds?.has(classId))
    || groups.find((group) => courseCode && group.courseCodes?.has(courseCode))
    || groups.find((group) => courseName && group.courseNames?.has(courseName))
    || groups.find((group) => classId && group.classIds?.has(classId))
    || (groups.length === 1 ? groups[0] : null)
    || null
}

function renderGradeInlineDetails(group, domain) {
  if (!group) return '<div class="grade-inline-detail"><p class="grade-breakdown-empty">教务系统未返回该课程的成绩组成。</p></div>'
  const summary = group.summary || group.components[0]
  const score = recordValue(summary, 'overallScore') || recordValue(summary, 'score') || '—'
  const fields = summary ? gradeDetailFieldList(summary) : []
  const termText = group.academicYear || group.term ? termLabel({ year: group.academicYear, term: group.term, label: group.term }) : ''
  return `<div class="grade-inline-detail"><div class="grade-inline-detail-head"><div><span class="kicker">成绩组成</span><strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(detailLine([group.courseCode, termText]) || '课程成绩')}</small></div><b>${escapeHtml(score)}</b></div>${domain?.completeness === 'partial' ? '<p class="grade-breakdown-empty">本次明细读取不完整。</p>' : ''}${fields.length ? `<dl>${fields.map((field) => `<div><dt>${escapeHtml(field.label || field.name)}</dt><dd>${escapeHtml(field.value)}</dd></div>`).join('')}</dl>` : ''}${group.components.length ? `<div class="grade-components"><h3>分项成绩</h3><div class="grade-component-list">${group.components.map((record) => `<div class="grade-component-item"><span>${escapeHtml(recordValue(record, 'assessmentItem') || record.title || '成绩分项')}</span><b>${escapeHtml(recordValue(record, 'componentScore') || recordValue(record, 'score') || '—')}</b><small>总评 ${escapeHtml(recordValue(record, 'overallScore') || '—')}</small></div>`).join('')}</div></div>` : '<p class="grade-breakdown-empty">教务系统未返回该课程的分项成绩。</p>'}</div>`
}

function gradeDetailAction(item, domain, groups) {
  const key = gradeDetailKey(item)
  const loading = state.extraLoading.has('grade-details')
  const open = state.gradeDetailOpen.has(key)
  const failed = Boolean(state.extraErrors['grade-details']) && !loading
  const disabled = !state.campus || loading
  return `<button type="button" class="grade-detail-button" data-grade-detail="${escapeHtml(key)}" ${disabled ? 'disabled' : ''}>${loading ? '查询中' : open ? '收起明细' : failed ? '重试成绩明细' : '查看成绩明细'}</button>`
}

function toggleGradeDetail(key) {
  const detailDomain = state.data?.academicExtras?.domains?.['grade-details']
  if (!state.campus || state.extraLoading.has('grade-details')) return
  if (state.extraErrors['grade-details']) {
    state.gradeDetailPending = String(key || '')
    void loadExtraDomain('grade-details', { force: true, gradeTerm: selectedTerm(state.data, 'gradeTerm') })
    return
  }
  if (!state.extraLoaded.has('grade-details') || !detailDomain) {
    state.gradeDetailPending = String(key || '')
    void loadExtraDomain('grade-details', { gradeTerm: selectedTerm(state.data, 'gradeTerm') })
    return
  }
  if (state.gradeDetailOpen.has(key)) state.gradeDetailOpen.delete(key)
  else state.gradeDetailOpen.add(key)
  renderView()
}

function renderSchedule() {
  const data = state.data || {}
  const allItems = scheduleItems(data).map((item, index) => ({ ...item, __scheduleIndex: index }))
  const weekMode = state.filters.scheduleMode || 'all'
  const selectedScheduleTerm = selectedTerm(data, 'scheduleTerm')
  const calendar = data.academicCalendar || OFFICIAL_ACADEMIC_CALENDAR
  // Calculate the automatic week against the selected term. Using the global
  // calendar here made a historical term show the current term's week number.
  const calendarWeek = currentWeekForTerm(selectedScheduleTerm, calendar)
  const maxWeek = Math.max(1, Math.min(64, Number(selectedScheduleTerm?.weeks) || calendarWeek?.of || 30))
  const week = Math.max(1, Math.min(maxWeek, Number(state.filters.scheduleWeek) || calendarWeek?.week || 1))
  const items = weekMode === 'week' ? allItems.filter((item) => occursInWeek(item.weeks, week)) : allItems
  const slotsByKey = new Map()
  const unscheduledItems = []
  for (const item of items) {
    const weekday = Number(item.weekday)
    const range = parsePeriodRange(item.period)
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > DAYS.length || !range) {
      unscheduledItems.push(item)
      continue
    }
    const key = `${weekday}-${range.start}-${range.end}`
    const slot = slotsByKey.get(key)
    if (slot) slot.items.push(item)
    else slotsByKey.set(key, { weekday, ...range, period: item.period, items: [item] })
  }
  const slots = [...slotsByKey.values()].sort((a, b) => a.start - b.start || a.weekday - b.weekday || a.end - b.end)
  const periodCount = Math.max(12, ...slots.map((slot) => slot.end))
  const dayCounts = DAYS.map((_label, index) => slots.filter((slot) => slot.weekday === index + 1).length)
  const scheduleCells = Array.from({ length: periodCount * DAYS.length }, (_value, index) => {
    const period = Math.floor(index / DAYS.length) + 1
    const weekday = index % DAYS.length + 1
    return `<div class="schedule-grid-cell" aria-hidden="true" style="grid-column:${weekday + 1};grid-row:${period + 1}"></div>`
  }).join('')
  const periodLabels = Array.from({ length: periodCount }, (_value, index) => `<div class="schedule-period-label" style="grid-column:1;grid-row:${index + 2}">第${index + 1}节</div>`).join('')
  const dayHeaders = DAYS.map((label, index) => `<header class="schedule-day-header" style="grid-column:${index + 2};grid-row:1"><strong>周${label}</strong><span>${dayCounts[index]} 门</span></header>`).join('')
  // Build colors from every loaded term before filtering by week or term. The
  // deterministic sorted mapping keeps a course's label color stable.
  const scheduleColors = scheduleColorMap(Array.isArray(data.schedule) ? data.schedule : allItems)
  const slotCards = slots.map((slot) => scheduleSlot(slot, scheduleColors)).join('')
  const weekOptions = Array.from({ length: maxWeek }, (_value, index) => index + 1).map((value) => `<option value="${value}" ${value === week ? 'selected' : ''}>第 ${value} 周</option>`).join('')
  const modeControls = `<div class="segmented" role="group" aria-label="课表范围"><button type="button" data-schedule-mode="week" class="${weekMode === 'week' ? 'is-active' : ''}">按周</button><button type="button" data-schedule-mode="all" class="${weekMode === 'all' ? 'is-active' : ''}">全学期</button></div>${weekMode === 'week' ? `<select class="control-select schedule-week-select" data-filter-key="scheduleWeek" aria-label="选择周次">${weekOptions}</select>` : ''}`
  const weekDescription = weekMode === 'week'
    ? `第 ${week} / ${maxWeek} 周${state.filters.scheduleWeek ? '' : ' · 自动定位'}`
    : `${items.length} 条安排`
  const detailItem = scheduleDetailItem(data, state.scheduleDetailOpen)
  const detailGroup = state.scheduleGroupOpen ? slots.find((slot) => scheduleSlotGroupKey(slot) === state.scheduleGroupOpen)?.items || [] : []
  return `<section class="page-section">${pageHeader('学习安排', '课表', `${termLabel(selectedTerm(data, 'scheduleTerm'))} · ${weekDescription}`)}${warningBar()}${filterBar(`<span class="filter-label">查看学期</span>${termSelectionControls(data, 'scheduleTerm')}${modeControls}`)}<div class="schedule-scroll"><section class="schedule-board" style="--schedule-period-count:${periodCount}" aria-label="按周一至周日和节次排列的完整课表"><div class="schedule-corner">节次</div>${dayHeaders}${periodLabels}${scheduleCells}${slotCards}</section></div>${unscheduledItems.length ? `<section class="schedule-unscheduled"><strong>时间或星期待定</strong><div>${unscheduledItems.map((item) => `<button type="button" data-schedule-detail="${escapeHtml(scheduleDetailKey(item))}">${escapeHtml(`${item.title || '未命名课程'}${item.weeks ? `（${item.weeks}）` : ''}`)}</button>`).join('')}</div></section>` : ''}${!items.length ? emptyState('当前学期或周次暂无课表数据') : ''}${detailItem ? scheduleDetailDialog(detailItem) : detailGroup.length > 1 ? scheduleGroupDialog(detailGroup) : ''}</section>`
}

function scheduleSlot(slot, colors) {
  const firstItem = slot.items[0] || {}
  const color = scheduleColorFor(firstItem, colors)
  const extraCount = Math.max(0, slot.items.length - 1)
  const crowdedClass = extraCount ? ' has-more' : ''
  const groupKey = scheduleSlotGroupKey(slot)
  const firstCardTarget = extraCount
    ? `data-schedule-group="${escapeHtml(groupKey)}"`
    : `data-schedule-detail="${escapeHtml(scheduleDetailKey(firstItem))}"`
  const firstCardLabel = extraCount ? `查看同一时段全部 ${slot.items.length} 门课程` : `查看 ${firstItem.title || '课程'} 详情`
  const firstCard = `<button type="button" class="schedule-slot-course" style="--course-background:${color.background};--course-border:${color.border};--course-ink:${color.ink};background-color:${color.background};border-color:${color.border}" ${firstCardTarget} aria-label="${escapeHtml(firstCardLabel)}"><strong title="${escapeHtml(firstItem.title || '未命名课程')}">${escapeHtml(firstItem.title || '未命名课程')}</strong><span title="${escapeHtml(firstItem.room || '地点待定')}">${escapeHtml(firstItem.room || '地点待定')}</span></button>`
  const groupAction = extraCount ? `<button type="button" class="schedule-slot-stack" data-schedule-group="${escapeHtml(groupKey)}" aria-label="查看同一时段全部 ${slot.items.length} 门课程" title="查看全部"><span class="schedule-stack-count">+${extraCount}</span><span class="schedule-stack-full">查看全部</span></button>` : ''
  return `<article class="schedule-slot${crowdedClass}" style="--schedule-slot-item-count:${slot.items.length};--schedule-stack-background:${color.background};--schedule-stack-border:${color.border};grid-column:${slot.weekday + 1};grid-row:${slot.start + 1} / ${slot.end + 2}">${firstCard}${groupAction}</article>`
}

function courseLibraryItems(data) {
  return (Array.isArray(data?.courses) ? data.courses : []).filter((item) => searchMatch(item, state.filters.courseQuery)).sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN'))
}

function renderCourses() {
  const data = state.data || {}
  const courses = courseLibraryItems(data)
  return `<section class="page-section">${pageHeader('学习资料', '课程库', `${courses.length} 门课程 · 汇总课表、成绩和考试`)}${warningBar()}${filterBar(searchControl('courseQuery', state.filters.courseQuery, '搜索课程名、教师或课程代码'))}<div class="course-grid">${courses.map((item) => `<article class="course-card"><div class="course-card-top"><span class="course-code">${escapeHtml(item.code || item.courseCode || '课程')}</span><span class="course-credit">${escapeHtml(item.credits ?? '—')} 学分</span></div><h2>${escapeHtml(item.title || item.courseName)}</h2><p>${escapeHtml(detailLine([item.teacher, item.category, item.location]))}</p><small>${escapeHtml((item.termIds || (item.termId ? [item.termId] : [])).map((value) => termLabel({ id: value })).join(' · ') || '学期待定')}</small></article>`).join('') || emptyState('暂无课程库数据')}</div></section>`
}

function renderAssignments() {
  const mode = state.filters.assignmentMode || 'pending'
  const all = Array.isArray(state.theolData.assignments) ? state.theolData.assignments.slice() : []
  const visible = all.filter((item) => mode === 'all' || (mode === 'submitted' ? item.status === 'submitted' : item.status !== 'submitted')).sort((left, right) => (dateValue(left.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER) - (dateValue(right.dueAt)?.getTime() || Number.MAX_SAFE_INTEGER))
  const assignmentLoaded = state.theolLoaded.has('assignments')
  const assignmentAction = state.campus && !state.theolLoading
    ? `<button type="button" class="secondary-button" data-action="${state.theolAuthRequired ? 'connect-theol' : state.theolError || assignmentLoaded ? 'refresh-theol' : 'connect-theol'}">${state.theolAuthRequired ? '连接课程平台' : state.theolError ? '重试读取作业' : assignmentLoaded ? '刷新作业与测试' : state.authenticating && state.authMode === 'theol' ? '正在打开认证页面' : '连接课程平台'}</button>`
    : ''
  return `<section class="page-section">${pageHeader('学习安排', '作业与测试', `${visible.length} 项 · 作业与在线测试只读查看`)}${theolStatus()}${filterBar(`<div class="segmented" role="group" aria-label="任务范围"><button type="button" data-assignment-mode="pending" class="${mode === 'pending' ? 'is-active' : ''}">待完成</button><button type="button" data-assignment-mode="submitted" class="${mode === 'submitted' ? 'is-active' : ''}">已提交</button><button type="button" data-assignment-mode="all" class="${mode === 'all' ? 'is-active' : ''}">全部</button></div>`)}<div class="theol-toolbar">${assignmentAction}<span class="section-meta">${assignmentLoaded ? `共 ${all.length} 项` : state.theolLoading ? '正在读取' : '需要课程平台会话'}</span></div><div class="item-list assignment-list">${visible.map((item) => `<article class="assignment-item"><div class="assignment-kind">${item.kind === 'online-test' ? '测试' : '作业'}</div><div class="item-body"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(detailLine([item.courseName, item.dueAt ? `截止 ${dateTimeLabel(item.dueAt)}` : '截止时间待定']))}</span></div><span class="assignment-status ${item.status === 'submitted' ? 'is-done' : ''}">${item.status === 'submitted' ? '已提交' : '待完成'}</span></article>`).join('') || emptyState(assignmentLoaded ? '当前没有匹配的作业或测试' : state.theolError ? '作业读取失败，请重试' : '连接课程平台后读取作业')}</div></section>`
}

function renderRecords() {
  const data = state.data || {}
  const exams = examItems(data)
  const grades = itemsForTerm(data.grades, selectedTerm(data, 'gradeTerm'))
  const active = state.recordsTab === 'exams' ? 'exams' : 'grades'
  const count = active === 'exams' ? exams.length : grades.length
  return `<section class="page-section records-page">${pageHeader('学习记录', '成绩与考试', `${count} 条 · ${active === 'exams' ? selectedTermLabel(data, 'examTerm') : selectedTermLabel(data, 'gradeTerm')}`)}${warningBar()}<div class="records-tabs" role="tablist" aria-label="成绩与考试"><button type="button" data-record-tab="grades" class="${active === 'grades' ? 'is-active' : ''}" role="tab" aria-selected="${active === 'grades'}"><span aria-hidden="true">∑</span>成绩 <b>${grades.length}</b></button><button type="button" data-record-tab="exams" class="${active === 'exams' ? 'is-active' : ''}" role="tab" aria-selected="${active === 'exams'}"><span aria-hidden="true">◷</span>考试 <b>${exams.length}</b></button></div>${active === 'exams' ? renderExamPanel(data) : renderGradePanel(data)}</section>`
}

function renderGradePanel(data) {
  const grades = itemsForTerm(data.grades, selectedTerm(data, 'gradeTerm'))
  const visible = grades.slice().sort(compareGradesByRecency)
  const detailDomain = data.academicExtras?.domains?.['grade-details']
  const detailRecords = gradeDetailRecords(detailDomain, selectedTerm(data, 'gradeTerm'))
  const detailGroups = gradeDetailGroups(detailRecords)
  return `${filterBar(`<span class="filter-label">查看学期</span>${termSelectionControls(data, 'gradeTerm', true)}`)}${extraStatus('grade-details')}<div class="grades-list">${visible.map((item) => {
    const key = gradeDetailKey(item)
    const group = gradeDetailGroupForItem(item, detailGroups)
    const open = state.gradeDetailOpen.has(key)
    return `<article class="grade-row"><div class="grade-row-main"><div class="grade-course"><strong>${escapeHtml(item.courseName)}</strong><small>${escapeHtml(detailLine([item.courseCode, item.teacher]))}</small></div><div class="grade-score"><strong>${escapeHtml(item.score || '—')}</strong><small>${escapeHtml(item.point != null ? `绩点 ${item.point}` : '绩点 —')}</small></div><div class="grade-row-action">${gradeDetailAction(item, detailDomain, detailGroups)}</div></div><div class="grade-row-meta"><span>${escapeHtml(item.credits != null ? `${item.credits} 学分` : '学分 —')}</span><span>${escapeHtml(item.nature || item.category || '性质待定')}</span><span>${escapeHtml(item.status || item.remark || '状态待定')}</span></div>${open ? `<div class="grade-detail-row">${renderGradeInlineDetails(group, detailDomain)}</div>` : ''}</article>`
  }).join('') || emptyState('暂无成绩记录')}</div>`
}

function renderExamPanel(data) {
  const exams = examItems(data)
  return `${filterBar(`<span class="filter-label">学期</span>${termSelectionControls(data, 'examTerm', true)}<select class="control-select" data-filter-key="examMode"><option value="upcoming" ${state.filters.examMode === 'upcoming' ? 'selected' : ''}>仅待考</option><option value="all" ${state.filters.examMode === 'all' ? 'selected' : ''}>全部考试</option></select>`)}<div class="item-list exam-list">${exams.map(examItem).join('') || emptyState(state.filters.examMode === 'all' ? '暂无考试记录' : '暂无待考安排')}</div>`
}

function renderGrades() {
  state.recordsTab = 'grades'
  return renderRecords()
}

function renderExams() {
  state.recordsTab = 'exams'
  return renderRecords()
}

function progressNodes(progress) {
  const output = []
  const walk = (nodes, depth = 0) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      output.push({ node, depth })
      walk(node.children, depth + 1)
    }
  }
  walk(progress?.roots?.length ? progress.roots : progress?.categories)
  return output
}

function progressPercent(required, earned) {
  const total = Number(required)
  const done = Number(earned)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return 0
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
}

function renderProgress() {
  const progress = state.data?.academicProgress
  const counts = progress?.courseCounts?.planned || {}
  const nodes = progressNodes(progress)
  return `<section class="page-section">${pageHeader('学业状态', '学业进度', progress?.program || '读取培养要求、课程完成情况和 GPA')}${warningBar()}<div class="progress-summary"><div class="progress-main"><span class="kicker">平均绩点</span><strong>${escapeHtml(progress?.gpa ?? state.data?.user?.gpa ?? '—')}</strong><small>${escapeHtml(progress?.requirementSource ? '已建立培养要求结构' : '教务系统汇总')}</small></div><div class="progress-counts"><div><strong>${escapeHtml(counts.passed ?? '—')}</strong><span>已通过</span></div><div><strong>${escapeHtml(counts.studying ?? '—')}</strong><span>在读</span></div><div><strong>${escapeHtml(counts.notTaken ?? '—')}</strong><span>未修</span></div><div><strong>${escapeHtml(counts.failed ?? '—')}</strong><span>未通过</span></div></div></div><section class="surface-section progress-section"><div class="section-title"><div><span class="kicker">培养要求</span><h2>完成情况</h2></div><span class="section-meta">${nodes.length} 项</span></div><div class="requirement-list">${nodes.map(({ node, depth }) => requirementItem(node, depth)).join('') || emptyState('暂无学业进度数据')}</div></section></section>`
}

function requirementItem(node, depth = 0) {
  const percent = progressPercent(node.required, node.earned)
  const courses = Array.isArray(node.courses) ? node.courses : []
  return `<div class="requirement-item" style="--depth:${Math.min(depth, 5)}"><div class="requirement-heading"><strong>${escapeHtml(node.title || '培养要求')}</strong><span>${escapeHtml(node.earned ?? '—')} / ${escapeHtml(node.required ?? '—')} 学分${courses.length ? ` · ${courses.length} 门课` : ''}</span></div><div class="progress-track"><i style="width:${percent}%"></i></div><small>${escapeHtml(node.status || `${percent}% 完成`)}${node.relation === 'or' ? ' · 满足其一即可' : ''}</small>${courses.length ? `<div class="progress-courses">${courses.map((course) => `<div class="progress-course"><div><strong>${escapeHtml(course.title)}</strong><span>${escapeHtml(detailLine([course.courseCode, course.nature || course.category]))}</span></div><b class="progress-course-status ${course.studyStatus === '已修' ? 'is-done' : course.studyStatus === '未通过' ? 'is-failed' : ''}">${escapeHtml(course.studyStatus || '待定')}</b><em>${escapeHtml(course.credits ?? '—')} 学分${course.score ? ` · ${course.score}` : ''}</em></div>`).join('')}</div>` : ''}</div>`
}

function planCourses(progress) {
  const output = []
  const walk = (nodes, parent = '') => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      for (const course of Array.isArray(node.courses) ? node.courses : []) output.push({ ...course, requirement: node.title || parent })
      walk(node.children, node.title || parent)
    }
  }
  walk(progress?.roots?.length ? progress.roots : progress?.categories)
  return output
}

function renderPlanContent() {
  const data = state.data || {}
  const progress = data.academicProgress
  const courses = planCourses(progress).filter((course) => searchMatch(course, state.filters.planQuery))
  const attachment = data.academicExtras?.domains?.['academic-plan']?.attachments?.[0]
  const pdfAction = attachment ? `<button type="button" class="secondary-button artifact-action" data-action="open-plan-pdf" ${state.planPdfOpening ? 'disabled' : ''}>${state.planPdfOpening ? '读取中' : '打开 PDF'} <span aria-hidden="true">↗</span></button>` : ''
  const pdfState = attachment ? (attachment.cached ? '已缓存到本机' : '已发现 PDF') : '刷新后自动查找当前专业 PDF'
  const pdfDialog = '<dialog class="plan-pdf-dialog" data-plan-pdf-dialog aria-label="官方培养计划 PDF"><button type="button" class="calendar-lightbox-close" data-action="close-plan-pdf" aria-label="关闭培养计划 PDF">×</button><div class="pdf-viewer" data-plan-pdf-viewer aria-live="polite"><div class="pdf-viewer-empty">点击“打开 PDF”后在这里显示培养计划</div></div></dialog>'
  return `${extraStatus('academic-plan')}${state.planPdfError ? `<div class="warning-bar" role="status">${escapeHtml(state.planPdfError)}</div>` : ''}${warningBar()}${filterBar(searchControl('planQuery', state.filters.planQuery, '搜索计划课程或培养要求'))}<div class="artifact-note"><span class="artifact-icon">PDF</span><div><strong>培养方案附件</strong><span>${attachment ? escapeHtml(attachment.label || attachment.filename || '官方培养计划 PDF') : '当前专业 PDF 尚未返回'}</span></div><small>${pdfState}</small>${pdfAction}</div>${pdfDialog}<div class="table-scroll"><table class="data-table plan-table"><thead><tr><th>培养要求</th><th>课程</th><th>代码</th><th>学分</th><th>状态</th><th>成绩</th><th>建议修读</th></tr></thead><tbody>${courses.map((course) => `<tr><td>${escapeHtml(course.requirement)}</td><td><strong>${escapeHtml(course.title)}</strong><small>${escapeHtml(course.nature || course.category || '')}</small></td><td>${escapeHtml(course.courseCode || '—')}</td><td>${escapeHtml(course.credits ?? '—')}</td><td>${escapeHtml(course.studyStatus || '—')}</td><td class="score-cell">${escapeHtml(course.score || course.bestScore || '—')}</td><td>${escapeHtml(detailLine([course.recommendedYear, course.recommendedTerm]))}</td></tr>`).join('') || '<tr><td colspan="7" class="table-empty">暂无培养计划课程</td></tr>'}</tbody></table></div>`
}

function renderPlan() {
  const data = state.data || {}
  const progress = data.academicProgress
  return `<section class="page-section">${pageHeader('学习资料', '培养计划', `${progress?.program || '当前专业培养方案'}`)}${renderPlanContent()}</section>`
}

function numericValue(value) {
  const match = String(value ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/u)
  if (!match) return null
  const number = Number(match[0])
  return Number.isFinite(number) ? number : null
}

function gradeScore(item) {
  const value = numericValue(item?.score)
  return value != null && value >= 0 && value <= 100 ? value : null
}

function gradePoint(item) {
  const value = numericValue(item?.point)
  return value != null && value >= 0 && value <= 5 ? value : null
}

function gradeOutcome(item) {
  const score = gradeScore(item)
  if (score != null) return score >= 60 ? 'passed' : 'failed'
  const text = `${item?.status || ''} ${item?.remark || ''} ${item?.score || ''}`
  if (/不及格|未通过|挂科|不合格/u.test(text)) return 'failed'
  if (/通过|合格|优秀|良好/u.test(text)) return 'passed'
  return 'unknown'
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value))
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null
}

function weightedAverage(rows, valueKey) {
  let total = 0
  let weight = 0
  for (const row of rows) {
    const value = numericValue(row?.[valueKey])
    const credits = numericValue(row?.credits)
    if (value == null || credits == null || credits <= 0) continue
    total += value * credits
    weight += credits
  }
  return weight ? total / weight : null
}

function calendarDateValue(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null
  const text = String(value || '').trim()
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/u)
  if (match) {
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    return Number.isFinite(date.getTime()) ? date : null
  }
  return dateValue(value)
}

function calendarDateLabel(value) {
  const date = calendarDateValue(value)
  return date ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date) : '日期待定'
}

function calendarDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function termDateRange(term) {
  const start = calendarDateValue(term?.startDate || term?.startAt || term?.beginDate || term?.start)
  const end = calendarDateValue(term?.endDate || term?.endAt || term?.finishDate || term?.end)
  return { start, end }
}

function termWeeks(term) {
  const explicit = numericValue(term?.weeks)
  if (explicit != null && explicit > 0) return Math.round(explicit)
  const { start, end } = termDateRange(term)
  if (!start || !end || end < start) return null
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000)))
}

function toolDateValue() {
  return calendarDateValue(state.filters.toolDate) || new Date()
}

function termAtDate(terms, date) {
  const time = date.getTime()
  return terms.find((term) => {
    const { start, end } = termDateRange(term)
    return start && end && time >= start.getTime() && time <= end.getTime() + 24 * 60 * 60 * 1000 - 1
  }) || null
}

function calendarTermCode(value) {
  return normalizedTermCode(value)
}

function calendarTermForDate(data, terms, date) {
  const calendar = data?.academicCalendar || OFFICIAL_ACADEMIC_CALENDAR
  const exact = termAtDate(terms, date)
  if (exact) return exact
  const phase = academicCalendarPhase(calendar, date)
  const target = phase?.kind === 'semester'
    ? phase
    : phase?.kind === 'upcoming'
      ? calendar.semesters.find((term) => term.startDate === phase.startDate) || phase
      : [...(calendar.semesters || [])]
        .filter((term) => String(term.startDate || '') > calendarDateKey(date))
        .sort((left, right) => String(left.startDate).localeCompare(String(right.startDate)))[0]
  if (target?.year && target?.term) {
    const matched = terms.find((term) => Number(term?.year) === Number(target.year) && calendarTermCode(term?.term) === calendarTermCode(target.term))
    if (matched) return matched
    return target
  }
  return terms.slice().sort((left, right) => {
    const leftStart = termDateRange(left).start?.getTime() || 0
    const rightStart = termDateRange(right).start?.getTime() || 0
    return rightStart - leftStart || Number(right?.year || 0) - Number(left?.year || 0)
  })[0] || null
}

function toolTermName(term, terms) {
  if (term) return termLabel(term)
  const id = term?.id || ''
  return id || (terms.length ? '未标注学期' : '暂无学期数据')
}

function renderCalendarReference() {
  const calendar = activeAcademicCalendar()
  const manifest = state.academicCalendarAssets.manifest
  const date = toolDateValue()
  const phase = academicCalendarPhase(calendar, date)
  const week = currentAcademicWeek(calendar, date)
  const phaseLabel = week && (phase?.kind === 'semester' || week.upcoming)
    ? `${phase?.label || week.label} · 第 ${week.week} / ${week.of} 周${week.upcoming ? '（即将开始）' : ''}`
    : phase?.label || '日期待定'
  const imageAlt = `北京化工大学 ${calendar.schoolYear || ''} 官方校历`
  const calendarAsset = manifest?.assetUrls?.calendar || assetUrl(calendar.asset || '')
  const errors = Object.values(manifest?.resourceErrors || {}).filter(Boolean)
  const weekly = manifest?.analysis?.weeklyCalendar
  const teaching = manifest?.analysis?.teachingSchedule
  const analysisError = manifest?.analysisError
  const currentWeek = week?.week || null
  const weeklyEntries = Array.isArray(weekly?.entries) ? weekly.entries : []
  const weeklyMatchesCurrentYear = Boolean(weekly?.academicYear && calendar?.schoolYear && weekly.academicYear === calendar.schoolYear)
  const dateKey = calendarDateKey(date)
  const datedEntries = weeklyEntries.filter((entry) => entry.startDate && entry.endDate)
  const dateMatches = dateKey
    ? datedEntries.filter((entry) => entry.startDate <= dateKey && entry.endDate >= dateKey)
    : []
  const upcomingEntries = datedEntries
    .filter((entry) => entry.startDate > dateKey)
    .sort((left, right) => left.startDate.localeCompare(right.startDate))
  const recentEntries = datedEntries
    .filter((entry) => entry.endDate < dateKey)
    .sort((left, right) => right.endDate.localeCompare(left.endDate))
  const nearbyEntries = dateMatches.length ? dateMatches : upcomingEntries.length ? upcomingEntries : recentEntries
  const matchingEntries = weeklyMatchesCurrentYear && currentWeek
    ? weeklyEntries.filter((entry) => entry.weekStart != null && entry.weekEnd != null && entry.weekStart <= currentWeek && entry.weekEnd >= currentWeek)
    : nearbyEntries
  const visibleEntries = (matchingEntries.length ? matchingEntries : weeklyEntries).slice(0, 7)
  const selectedTeaching = teaching?.match?.selected
  const resourceCard = (key, title, detail) => {
    const entry = manifest?.assets?.[key]
    const ready = Boolean(entry?.filename)
    const error = manifest?.resourceErrors?.[key]
    const action = ready
      ? `<button type="button" class="calendar-resource-action" data-calendar-pdf-key="${escapeHtml(key)}" ${state.academicCalendarPdfOpening ? 'disabled' : ''}>${state.academicCalendarPdfOpening === key ? '打开中' : '打开 PDF'} <span aria-hidden="true">↗</span></button>`
      : `<b class="${error ? 'has-error' : ''}">${error ? '失败' : '等待'}</b>`
    return `<article class="calendar-resource"><div><strong>${title}</strong><span>${ready ? `${detail} · ${Math.max(1, Math.round(Number(entry.bytes || 0) / 1024))} KB` : '尚未获取'}</span></div>${action}</article>`
  }
  const status = state.academicCalendarAssets.loading
    ? '正在检查教务处资源…'
    : state.academicCalendarAssets.error
      ? state.academicCalendarAssets.error
      : analysisError
        ? `PDF 解析失败，已保留资源缓存：${analysisError}`
        : errors.length
        ? `部分资源读取失败，已保留可用缓存：${errors[0]}`
        : manifest?.updatedAt
          ? `最近检查 ${dateTimeLabel(manifest.updatedAt)}`
          : '尚未检查官方资源'
  const weeklyDetail = weekly?.academicYear ? `${weekly.academicYear} · ${weekly?.entries?.length || 0} 条事项` : `${weekly?.entries?.length || 0} 条事项`
  const weeklyNotice = weekly?.academicYear && calendar?.schoolYear && weekly.academicYear !== calendar.schoolYear
    ? `<span class="calendar-stale-note">当前学年为 ${escapeHtml(calendar.schoolYear)}；教务处目前公开的最新周历为 ${escapeHtml(weekly.academicYear)}，已显示已抓取内容。</span>`
    : ''
  const resources = `${resourceCard('teachingSchedule', '教学进程表', '本学年安排')}${resourceCard('weeklyCalendar', '工作周历', weeklyDetail)}`
  const weekItems = visibleEntries.map((entry) => `<button type="button" class="calendar-week-item" data-calendar-week-detail="${escapeHtml(calendarWeekDetailKey(entry))}" aria-label="查看 ${escapeHtml(entry.summary || '工作周历事项')} 详情"><b>${escapeHtml(calendarEntryDateLabel(entry) || '日期待定')}</b><span class="calendar-week-item-main"><strong>${escapeHtml(calendarText(entry.summary) || '事项待定')}</strong></span><span class="calendar-week-item-arrow" aria-hidden="true">›</span></button>`).join('') || '<span class="calendar-empty-note">工作周历 PDF 尚未解析，刷新后会自动处理。</span>'
  const imageBlock = calendarAsset
    ? `<button type="button" class="calendar-reference-image" data-action="open-calendar-image" aria-label="放大校历图片"><img src="${escapeHtml(calendarAsset)}" alt="${escapeHtml(imageAlt)}" loading="eager"><span aria-hidden="true">放大</span></button><dialog class="calendar-lightbox" data-calendar-dialog aria-label="${escapeHtml(imageAlt)}"><button type="button" class="calendar-lightbox-close" data-action="close-calendar-image" aria-label="关闭校历大图">×</button><img src="${escapeHtml(calendarAsset)}" alt="${escapeHtml(imageAlt)}"></dialog>`
    : '<div class="calendar-reference-image calendar-image-empty"><span>官方图片尚未获取</span></div>'
  const teachingBlock = teaching
    ? `<div class="calendar-teaching-summary"><span class="kicker">教学进程</span><strong>${selectedTeaching ? escapeHtml(selectedTeaching.classGroups.join('、') || '已匹配当前年级') : '已获取，暂未匹配专业'}</strong><span>${selectedTeaching ? escapeHtml(detailLine(selectedTeaching.schedule.phases.map((item) => `${item.kind}${item.weeks ? ` ${item.weeks} 周` : ''}`))) : `${teaching.rows?.length || 0} 个年级记录 · 可在教务处 PDF 查看完整表格`}</span></div>`
    : ''
  const weeklyHeading = weekly?.academicYear ? `${weekly.academicYear} · 附近事项` : '附近事项'
  const weeklyDetailEntry = weeklyEntries.find((entry) => calendarWeekDetailKey(entry) === state.calendarWeekDetailOpen)
  const calendarPdfError = state.academicCalendarPdfError ? `<div class="warning-bar" role="status">${escapeHtml(state.academicCalendarPdfError)}</div>` : ''
  const calendarPdfDialog = `<dialog class="plan-pdf-dialog calendar-pdf-dialog" data-calendar-pdf-dialog aria-label="校历 PDF"><button type="button" class="calendar-lightbox-close" data-action="close-calendar-pdf" aria-label="关闭校历 PDF">×</button><div class="pdf-viewer" data-calendar-pdf-viewer aria-live="polite"><div class="pdf-viewer-empty">点击“打开 PDF”后在这里显示</div></div></dialog>`
  return `<section class="calendar-reference"><div class="calendar-reference-main"><div class="calendar-reference-title"><div><span class="kicker">官方校历 · 自动更新</span><h2>${escapeHtml(calendar.schoolYear || '校历')}</h2></div><button type="button" class="secondary-button calendar-refresh-button" data-action="refresh-academic-calendar" ${state.academicCalendarAssets.loading ? 'disabled' : ''}><span class="refresh-symbol ${state.academicCalendarAssets.loading ? 'spin' : ''}">↻</span>${state.academicCalendarAssets.loading ? '检查中' : '检查更新'}</button></div><p>${escapeHtml(calendar.source || '北京化工大学教务处')} · ${escapeHtml(calendar.publishedAt || '官方资料')}</p><strong>${escapeHtml(phaseLabel)}</strong><small class="calendar-resource-status">${escapeHtml(status)}</small>${calendarPdfError}<div class="calendar-resource-grid">${resources}</div></div>${imageBlock}${calendarPdfDialog}<div class="calendar-reference-details"><div class="calendar-detail-heading"><span class="kicker">工作周历</span><strong>${escapeHtml(weeklyHeading)}</strong></div>${weeklyNotice}<div class="calendar-week-list">${weekItems}</div>${teachingBlock}</div>${weeklyDetailEntry ? calendarWeekDetailDialog(weeklyDetailEntry) : ''}</section>`
}

function renderTools() {
  const data = state.data || {}
  const calendar = activeAcademicCalendar()
  const sourceTerms = termsOf(data)
  const terms = sourceTerms.length ? sourceTerms : calendar.semesters
  const calendarTerms = terms
  const date = toolDateValue()
  const dateValue = calendarDateKey(date)
  const activeTerm = calendarTermForDate(data, calendarTerms, date)
  const activeTermId = termId(activeTerm)
  const week = currentAcademicWeek(calendar, date)
  const phase = academicCalendarPhase(calendar, date)
  const calendarItems = itemsForTerm(data.schedule, activeTerm)
    .filter((item) => Boolean(activeTermId) && Number(item.weekday) === (date.getDay() || 7))
    .sort((left, right) => String(left.period || '').localeCompare(String(right.period || ''), 'zh-CN'))
  const grades = Array.isArray(data.grades) ? data.grades : []
  const scored = grades.map((item) => ({ item, score: gradeScore(item) })).filter((entry) => entry.score != null)
  const points = grades.filter((item) => gradePoint(item) != null)
  const outcomes = grades.map((item) => gradeOutcome(item)).filter((value) => value !== 'unknown')
  const passed = outcomes.filter((value) => value === 'passed').length
  const credits = grades.map((item) => numericValue(item.credits)).filter((value) => value != null && value > 0)
  const scoreBuckets = [
    { label: '90 分以上', count: scored.filter(({ score }) => score >= 90).length },
    { label: '80–89 分', count: scored.filter(({ score }) => score >= 80 && score < 90).length },
    { label: '70–79 分', count: scored.filter(({ score }) => score >= 70 && score < 80).length },
    { label: '60–69 分', count: scored.filter(({ score }) => score >= 60 && score < 70).length },
    { label: '60 分以下', count: scored.filter(({ score }) => score < 60).length },
  ]
  const maxBucket = Math.max(1, ...scoreBuckets.map((bucket) => bucket.count))
  const trend = new Map()
  for (const item of grades) {
    const key = gradeRecordTermId(item) || '__unknown__'
    if (!trend.has(key)) trend.set(key, [])
    trend.get(key).push(item)
  }
  const orderedTrend = [...trend.entries()].sort((left, right) => {
    const leftIndex = terms.findIndex((term) => termId(term) === left[0])
    const rightIndex = terms.findIndex((term) => termId(term) === right[0])
    if (leftIndex < 0 && rightIndex < 0) return left[0].localeCompare(right[0])
    if (leftIndex < 0) return 1
    if (rightIndex < 0) return -1
    return leftIndex - rightIndex
  })
  const calendarTab = state.toolTab === 'calendar'
  return `<section class="page-section study-tools-page">${pageHeader('校园工具', '学习工具', '校历、成绩分析和常用教务入口集中在这里。')}${warningBar()}<div class="study-tools-tabs" role="tablist" aria-label="学习工具分类"><button type="button" data-tool-tab="calendar" class="${calendarTab ? 'is-active' : ''}" role="tab" aria-selected="${calendarTab}"><span aria-hidden="true">▣</span>校历与时间线</button><button type="button" data-tool-tab="analysis" class="${!calendarTab ? 'is-active' : ''}" role="tab" aria-selected="${!calendarTab}"><span aria-hidden="true">∑</span>成绩分析</button></div>${calendarTab ? `<section class="study-tools-section"><div class="tool-date-bar"><div><span class="kicker">日期定位</span><h2>今天在学期中的位置</h2></div><div class="tool-date-actions"><input type="date" class="control-select" data-filter-key="toolDate" value="${escapeHtml(state.filters.toolDate || dateValue)}" aria-label="选择日期"><button type="button" class="secondary-button" data-action="tool-today">回到今天</button></div></div><div class="tool-date-summary"><div><span>选择日期</span><strong>${escapeHtml(calendarDateLabel(date))}</strong></div><div><span>所在学期</span><strong>${escapeHtml(activeTerm ? termLabel(activeTerm) : '未匹配到学期')}</strong></div><div><span>教学周</span><strong>${activeTerm && termDateRange(activeTerm).start ? `第 ${Math.max(1, Math.floor((date.getTime() - termDateRange(activeTerm).start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1)} 周` : '待定'}</strong></div><div><span>当天课程</span><strong>${calendarItems.length || '—'}</strong></div></div><div class="tool-day-panel"><div class="section-title"><div><span class="kicker">${date.toLocaleDateString('zh-CN', { weekday: 'long' })}</span><h2>${activeTerm ? '当天课程' : '课程安排'}</h2></div><span class="section-meta">${calendarItems.length ? `${calendarItems.length} 条` : '暂无记录'}</span></div><div class="item-list">${calendarItems.map(scheduleItem).join('') || emptyState(activeTerm ? '这一天没有已读取课程' : '当前日期不在已读取学期范围内')}</div></div><div class="section-title timeline-heading"><div><span class="kicker">已读取学期</span><h2>学期时间线</h2></div><span class="section-meta">${terms.length ? `${terms.length} 个学期` : '暂无学期'}</span></div><div class="term-timeline">${terms.map((term) => { const range = termDateRange(term); const weeks = termWeeks(term); const active = termId(term) === activeTermId; return `<article class="term-timeline-item ${active ? 'is-current' : ''}"><div class="term-timeline-marker"></div><div class="term-timeline-copy"><div><strong>${escapeHtml(termLabel(term))}</strong>${active ? '<span class="term-current-badge">当前日期</span>' : ''}</div><span>${range.start && range.end ? `${escapeHtml(calendarDateLabel(range.start))} 至 ${escapeHtml(calendarDateLabel(range.end))}` : '教务系统未提供起止日期'}${weeks ? ` · 约 ${weeks} 周` : ''}</span></div></article>` }).join('') || emptyState('暂无校历学期数据')}</div></section>` : `<section class="study-tools-section"><div class="analysis-head"><div><span class="kicker">本地统计</span><h2>成绩概况</h2><p>仅统计当前已读取的成绩记录；非数字等级不会被强行换算。</p></div><button type="button" class="secondary-button" data-view="grades">打开成绩记录 <span aria-hidden="true">→</span></button></div><div class="analysis-stats"><div class="analysis-stat"><span>数字成绩平均分</span><strong>${scored.length ? average(scored.map(({ score }) => score)).toFixed(1) : '—'}</strong><small>${scored.length} 条可计算记录</small></div><div class="analysis-stat"><span>平均绩点</span><strong>${points.length ? (weightedAverage(points, 'point') ?? average(points.map(gradePoint))).toFixed(2) : '—'}</strong><small>${points.length ? '按学分加权，缺少学分时取记录平均' : '暂无可计算绩点'}</small></div><div class="analysis-stat"><span>通过率</span><strong>${outcomes.length ? `${Math.round((passed / outcomes.length) * 100)}%` : '—'}</strong><small>${outcomes.length ? `${passed} / ${outcomes.length} 条可判定记录` : '暂无可判定记录'}</small></div><div class="analysis-stat"><span>已记录学分</span><strong>${credits.length ? credits.reduce((sum, value) => sum + value, 0).toFixed(1) : '—'}</strong><small>${grades.length} 条成绩记录</small></div></div><div class="analysis-grid"><section class="tool-day-panel"><div class="section-title"><div><span class="kicker">分数段</span><h2>成绩分布</h2></div><span class="section-meta">${scored.length} 条数字成绩</span></div><div class="score-distribution">${scoreBuckets.map((bucket) => `<div class="score-distribution-row"><span>${bucket.label}</span><div class="score-distribution-track"><i style="width:${Math.round((bucket.count / maxBucket) * 100)}%"></i></div><strong>${bucket.count}</strong></div>`).join('') || emptyState('暂无数字成绩')}</div></section><section class="tool-day-panel"><div class="section-title"><div><span class="kicker">学期趋势</span><h2>平均分变化</h2></div><span class="section-meta">按成绩记录归类</span></div><div class="term-trend">${orderedTrend.map(([key, items]) => { const values = items.map(gradeScore).filter((value) => value != null); return `<div class="term-trend-row"><div><strong>${escapeHtml(key === '__unknown__' ? toolTermName(null, terms) : toolTermName(terms.find((term) => termId(term) === key), terms))}</strong><span>${items.length} 条记录</span></div><b>${values.length ? average(values).toFixed(1) : '—'}</b></div>` }).join('') || emptyState('暂无可分析的成绩趋势')}</div></section></div></section>`}</section>`
}

function renderToolsPage() {
  const data = state.data || {}
  const calendar = activeAcademicCalendar()
  const terms = termsOf(data).length ? termsOf(data) : calendar.semesters
  const date = toolDateValue()
  const activeTerm = calendarTermForDate(data, terms, date)
  const activeTermId = termId(activeTerm)
  const calendarItems = itemsForTerm(data.schedule, activeTerm)
    .filter((item) => Boolean(activeTermId) && Number(item.weekday) === (date.getDay() || 7))
    .sort((left, right) => String(left.period || '').localeCompare(String(right.period || ''), 'zh-CN'))
  const grades = Array.isArray(data.grades) ? data.grades : []
  const scored = grades.map((item) => gradeScore(item)).filter((value) => value != null)
  const points = grades.filter((item) => gradePoint(item) != null)
  const outcomes = grades.map((item) => gradeOutcome(item)).filter((value) => value !== 'unknown')
  const passed = outcomes.filter((value) => value === 'passed').length
  const credits = grades.map((item) => numericValue(item.credits)).filter((value) => value != null && value > 0)
  const calendarTab = state.toolTab === 'calendar'
  const planTab = state.toolTab === 'plan'
    const scoreAverage = scored.length ? average(scored).toFixed(1) : '—'
  const pointAverage = points.length ? (weightedAverage(points, 'point') ?? average(points.map(gradePoint))).toFixed(2) : '—'
  const tabs = `<div class="study-tools-tabs" role="tablist" aria-label="学习工具分类"><button type="button" data-tool-tab="calendar" class="${calendarTab ? 'is-active' : ''}" role="tab" aria-selected="${calendarTab}"><span aria-hidden="true">▣</span>校历</button><button type="button" data-tool-tab="analysis" class="${!calendarTab && !planTab ? 'is-active' : ''}" role="tab" aria-selected="${!calendarTab && !planTab}"><span aria-hidden="true">∑</span>成绩分析</button><button type="button" data-tool-tab="plan" class="${planTab ? 'is-active' : ''}" role="tab" aria-selected="${planTab}"><span aria-hidden="true">≋</span>培养计划</button></div>`
  let body = ''
  if (calendarTab) {
    const calendarDate = calendarDateKey(date)
    const activeWeek = currentWeekForTerm(activeTerm, calendar, date)?.week || null
    body = `<section class="study-tools-section"><div class="tool-date-bar"><div><span class="kicker">日期定位</span><h2>今天在学期中的位置</h2></div><div class="tool-date-actions"><input type="date" class="control-select" data-filter-key="toolDate" value="${escapeHtml(state.filters.toolDate || calendarDate)}" aria-label="选择日期"><button type="button" class="secondary-button" data-action="tool-today">回到今天</button></div></div><div class="tool-date-summary"><div><span>选择日期</span><strong>${escapeHtml(calendarDateLabel(date))}</strong></div><div><span>所在学期</span><strong>${escapeHtml(activeTerm ? termLabel(activeTerm) : '未匹配到学期')}</strong></div><div><span>教学周</span><strong>${activeWeek ? `第 ${activeWeek} 周` : '待定'}</strong></div><div><span>当天课程</span><strong>${calendarItems.length || '—'}</strong></div></div><div class="tool-day-panel"><div class="section-title"><div><span class="kicker">${date.toLocaleDateString('zh-CN', { weekday: 'long' })}</span><h2>${activeTerm ? '当天课程' : '课程安排'}</h2></div><span class="section-meta">${calendarItems.length ? `${calendarItems.length} 条` : '暂无记录'}</span></div><div class="item-list">${calendarItems.map(scheduleItem).join('') || emptyState(activeTerm ? '这一天没有已读取课程' : '当前日期不在已读取学期范围内')}</div></div><div class="section-title timeline-heading"><div><span class="kicker">已读取学期</span><h2>学期时间线</h2></div><span class="section-meta">${terms.length ? `${terms.length} 个学期` : '暂无学期'}</span></div><div class="term-timeline">${terms.map((term) => { const range = termDateRange(term); const weeks = termWeeks(term); const active = termId(term) === activeTermId; return `<article class="term-timeline-item ${active ? 'is-current' : ''}"><div class="term-timeline-marker"></div><div class="term-timeline-copy"><div><strong>${escapeHtml(termLabel(term))}</strong>${active ? '<span class="term-current-badge">当前日期</span>' : ''}</div><span>${range.start && range.end ? `${escapeHtml(calendarDateLabel(range.start))} 至 ${escapeHtml(calendarDateLabel(range.end))}` : '教务系统未提供起止日期'}${weeks ? ` · 约 ${weeks} 周` : ''}</span></div></article>` }).join('') || emptyState('暂无校历学期数据')}</div></section>`
  } else if (planTab) {
    const progress = data.academicProgress
    body = `<section class="study-tools-section tools-plan-section"><div class="tool-embedded-heading"><span class="kicker">学习资料</span><h2>${escapeHtml(progress?.program || '培养计划')}</h2><p>按培养要求查看计划课程和建议修读安排。</p></div>${renderPlanContent()}</section>`
  } else {
    const scoreBuckets = [
      { label: '90 分以上', count: scored.filter((value) => value >= 90).length },
      { label: '80–89 分', count: scored.filter((value) => value >= 80 && value < 90).length },
      { label: '70–79 分', count: scored.filter((value) => value >= 70 && value < 80).length },
      { label: '60–69 分', count: scored.filter((value) => value >= 60 && value < 70).length },
      { label: '60 分以下', count: scored.filter((value) => value < 60).length },
    ]
    const maxBucket = Math.max(1, ...scoreBuckets.map((bucket) => bucket.count))
    body = `<section class="study-tools-section"><div class="analysis-head"><div><span class="kicker">本地统计</span><h2>成绩概况</h2><p>仅统计当前已读取的成绩记录；非数字等级不会被强行换算。</p></div><button type="button" class="secondary-button" data-view="records" data-record-tab="grades">打开成绩记录 <span aria-hidden="true">→</span></button></div><div class="analysis-stats"><div class="analysis-stat"><span>数字成绩平均分</span><strong>${scoreAverage}</strong><small>${scored.length} 条可计算记录</small></div><div class="analysis-stat"><span>平均绩点</span><strong>${pointAverage}</strong><small>${points.length ? '按学分加权，缺少学分时取记录平均' : '暂无可计算绩点'}</small></div><div class="analysis-stat"><span>通过率</span><strong>${outcomes.length ? `${Math.round((passed / outcomes.length) * 100)}%` : '—'}</strong><small>${outcomes.length ? `${passed} / ${outcomes.length} 条可判定记录` : '暂无可判定记录'}</small></div><div class="analysis-stat"><span>已记录学分</span><strong>${credits.length ? credits.reduce((sum, value) => sum + value, 0).toFixed(1) : '—'}</strong><small>${grades.length} 条成绩记录</small></div></div><div class="score-distribution">${scoreBuckets.map((bucket) => `<div class="score-distribution-row"><span>${bucket.label}</span><div class="score-distribution-track"><i style="width:${Math.round((bucket.count / maxBucket) * 100)}%"></i></div><strong>${bucket.count}</strong></div>`).join('')}</div></section>`
  }
  return `<section class="page-section study-tools-page">${pageHeader('校园工具', '学习工具', '校历、成绩分析和培养计划集中在这里。')}${warningBar()}${tabs}${body}</section>`
}

function renderNotices() {
  const data = state.data || {}
  const notices = [...new Map([...(Array.isArray(data.notices) ? data.notices : []), ...(Array.isArray(state.theolData.notices) ? state.theolData.notices : [])].map((item) => [item.id || `${item.source}:${item.title}`, item])).values()]
    .filter((item) => searchMatch(item, state.filters.noticeQuery))
    .sort((a, b) => (dateValue(b.publishedAt)?.getTime() || 0) - (dateValue(a.publishedAt)?.getTime() || 0))
  const theolAction = state.campus ? `<button type="button" class="secondary-button" data-action="${state.theolAuthRequired ? 'connect-theol' : 'refresh-theol'}" ${state.theolLoading ? 'disabled' : ''}>${state.theolLoading ? '读取中' : state.theolAuthRequired ? '连接课程平台' : '读取课程平台通知'}</button>` : ''
  return `<section class="page-section">${pageHeader('校园消息', '通知中心', `${notices.length} 条 · 教务系统与课程平台`)}${theolStatus()}${warningBar()}${filterBar(`${searchControl('noticeQuery', state.filters.noticeQuery, '搜索通知标题或内容')}${theolAction}`)}<div class="notice-list">${notices.map((notice) => `<article class="notice-item"><div class="notice-date">${escapeHtml(notice.publishedAt ? dateLabel(notice.publishedAt) : '暂无日期')}</div><div><h2>${escapeHtml(notice.title)}</h2><p>${escapeHtml(detailLine([notice.source === 'theol' ? '课程平台' : '教务系统', notice.summary || '暂无摘要']))}</p></div><span class="notice-arrow" aria-hidden="true">→</span></article>`).join('') || emptyState('暂无校园通知')}</div></section>`
}

function renderSettings() {
  const connected = Boolean(state.campus)
  const user = state.data?.user || {}
  const mode = state.campus?.mode || ''
  const connectionLabel = mode === 'api' ? '教务 API' : mode === 'cas' ? 'CAS 统一身份认证' : '校园账号'
  return `<section class="page-section">
    ${pageHeader('应用设置', '设置', '管理校园账号和本地应用状态。', false)}
    ${state.authError ? `<div class="warning-bar" role="status">${escapeHtml(state.authError)}</div>` : ''}
    <div class="settings-stack">
      <section class="surface-section settings-panel">
        <div class="section-title"><div><span class="kicker">当前连接</span><h2>${connected ? `已连接 ${connectionLabel}` : '尚未添加账号'}</h2></div><span class="connection-badge ${connected ? 'is-connected' : ''}"><span class="connection-dot"></span>${connected ? '已连接' : '未连接'}</span></div>
        <p class="settings-description">${connected ? `当前账号：${escapeHtml(user.studentId || user.username || user.name || '已认证账号')}。登录会话保存在本机，方便下次自动恢复，不保存密码。` : '账号不是必需的。选择一种方式添加后，应用会读取教务系统的只读数据。'}</p>
        ${connected ? '<button class="quiet-button settings-logout" data-action="logout">退出当前账号</button>' : ''}
      </section>
      <div class="auth-method-grid">
        <section class="surface-section settings-panel auth-method-panel">
          <div class="section-title"><div><span class="kicker">方式一</span><h2>CAS 统一身份认证</h2></div><span class="auth-method-mark">CAS</span></div>
           <p class="settings-description">在学校官方认证页面完成登录，成功后自动连接教务系统和课程平台；会话会保存到本机。</p>
          <button class="primary-button" data-action="connect-account" ${state.authenticating ? 'disabled' : ''}><span>${state.authenticating && state.authMode === 'cas' ? '正在打开认证页面' : connected && mode === 'cas' ? '重新认证 CAS 账号' : '使用 CAS 登录'}</span><span aria-hidden="true">→</span></button>
        </section>
        <section class="surface-section settings-panel auth-method-panel">
          <div class="section-title"><div><span class="kicker">方式二</span><h2>教务 API 账号</h2></div><span class="auth-method-mark api">API</span></div>
          <p class="settings-description">直接使用教务系统账号密码登录。密码仅用于本次 API 会话，不会写入文件。</p>
          <form class="api-login-form" data-auth-form="api">
            <label class="field compact-field"><span>教务系统账号</span><input name="api-username" autocomplete="username" value="${escapeHtml(state.apiUsername)}" placeholder="学号或教务账号"></label>
            <label class="field compact-field"><span>教务系统密码</span><input type="password" name="api-password" autocomplete="current-password" placeholder="输入教务系统密码"></label>
            <button type="submit" class="primary-button" data-action="connect-api-account" ${state.authenticating ? 'disabled' : ''}><span>${state.authenticating && state.authMode === 'api' ? '正在登录教务 API' : connected && mode === 'api' ? '重新登录教务 API' : '使用教务 API 登录'}</span><span aria-hidden="true">→</span></button>
          </form>
        </section>
      </div>
      <section class="surface-section settings-panel">
        <div class="section-title"><div><span class="kicker">数据范围</span><h2>只读教务数据</h2></div></div>
        <p class="settings-description">应用只读取课表、课程、考试、成绩、培养进度和教务通知等信息，不提交选课、申请、上传或其他学校侧操作。</p>
      </section>
    </div>
  </section>`
}

function extraDomain(domain) {
  return state.data?.academicExtras?.domains?.[domain] || null
}

function recordFields(record) {
  if (Array.isArray(record?.fields) && record.fields.length) return record.fields.filter((field) => field?.value != null && String(field.value).trim())
  return Object.entries(record || {})
    .filter(([key, value]) => !['id', 'title', 'sourceUrl', 'capturedAt', 'routeCode'].includes(key) && value != null && String(value).trim())
    .map(([name, value]) => ({ name, label: name, value }))
}

function recordTitle(record) {
  return record?.title || recordFields(record)[0]?.value || '教务记录'
}

function recordCard(record) {
  const fields = recordFields(record).filter((field) => String(field.value) !== String(recordTitle(record))).slice(0, 12)
  return `<article class="record-card"><div class="record-heading"><h2>${escapeHtml(recordTitle(record))}</h2><span>${escapeHtml(record.routeCode || '')}</span></div><div class="record-fields">${fields.map((field) => `<div><span>${escapeHtml(field.label || field.name)}</span><strong>${escapeHtml(field.value)}</strong></div>`).join('')}</div></article>`
}

function renderExtraDomain(domain, title, kicker, subtitle, filterKey) {
  const data = extraDomain(domain)
  const records = (Array.isArray(data?.records) ? data.records : []).filter((record) => searchMatch(record, state.filters[filterKey]))
  const meta = data ? `${records.length} 条记录 · ${data.completeness === 'partial' ? '部分读取' : '已读取'}` : '该数据域暂无返回'
  return `<section class="page-section">${pageHeader(kicker, title, `${subtitle} · ${meta}`)}${extraStatus(domain)}${warningBar()}${filterBar(searchControl(filterKey, state.filters[filterKey], '搜索记录内容'))}${data?.messages?.length ? `<div class="info-note">${escapeHtml(data.messages[0])}</div>` : ''}<div class="record-grid">${records.map(recordCard).join('') || emptyState(data ? '暂无匹配记录' : '暂无该数据域')}</div></section>`
}

function venueListForCampus(catalog, campusId = '') {
  const venues = Array.isArray(catalog?.venues) ? catalog.venues : []
  return venues.filter((venue) => !campusId || venue.campusId === campusId)
}

function venueRecord(catalog, venueId) {
  return (Array.isArray(catalog?.venues) ? catalog.venues : []).find((venue) => venue.id === venueId) || null
}

function venueStatusStateLabel(stateName) {
  return { available: '可用', occupied: '占用', closed: '关闭', expired: '过期', selected: '选中', unknown: '未知' }[stateName] || '未知'
}

function renderVenueResult(result) {
  if (!result) return ''
  const summary = result.availability?.summary || {}
  const byState = summary.byState || {}
  const tables = Array.isArray(result.availability?.tables) ? result.availability.tables : []
  return `<section class="venue-status-results"><div class="venue-results-head"><div><span class="kicker">查询结果</span><h2>${escapeHtml(result.query?.venue || '场馆')}</h2><p>${escapeHtml(detailLine([result.query?.activity, result.query?.campus?.label, result.query?.date]))}</p></div><div class="venue-metrics"><span><strong>${escapeHtml(summary.timeSlots || 0)}</strong>时段</span><span><strong>${escapeHtml(summary.courtStatusCells || 0)}</strong>场地</span></div></div><div class="venue-legend">${Object.entries(byState).map(([key, value]) => `<span class="venue-state ${escapeHtml(key)}"><i></i>${escapeHtml(venueStatusStateLabel(key))} ${escapeHtml(value)}</span>`).join('')}</div><div class="venue-table-list">${tables.map((table) => `<section class="venue-table-card"><div class="venue-table-title"><strong>场地状态</strong><span>${escapeHtml(table.slots?.length || 0)} 个时段</span></div><div class="venue-slot-list">${(table.slots || []).map((slot) => `<div class="venue-slot"><strong>${escapeHtml(slot.time)}</strong><div>${(slot.courts || []).map((court) => `<span class="venue-court ${escapeHtml(court.state)}"><b>${escapeHtml(court.court)}</b><small>${escapeHtml(court.status)}</small></span>`).join('')}</div></div>`).join('') || emptyState('暂无可解析的场地状态')}</div></section>`).join('') || emptyState('场馆页面暂无可解析的时段')}</div></section>`
}

function renderVenues() {
  const catalog = state.venueCatalog
  const campuses = Array.isArray(catalog?.campuses) ? catalog.campuses : []
  const selectedCampus = state.venueCampus || campuses[0]?.id || ''
  const venues = venueListForCampus(catalog, selectedCampus)
  const selectedId = state.venueId && venues.some((venue) => venue.id === state.venueId) ? state.venueId : venues[0]?.id || ''
  const selected = venueRecord(catalog, selectedId)
  const campusOptions = campuses.map((campus) => `<option value="${escapeHtml(campus.id)}" ${campus.id === selectedCampus ? 'selected' : ''}>${escapeHtml(campus.label)}</option>`).join('')
  const venueOptions = venues.map((venue) => `<option value="${escapeHtml(venue.id)}" ${venue.id === selectedId ? 'selected' : ''}>${escapeHtml(venue.label || venue.activity)}</option>`).join('')
  return `<section class="page-section venues-page"><div class="page-header"><div><span class="kicker">校园资源</span><h1>场馆查询</h1><p>查看公开场地时段状态，只读读取，不包含预约操作。</p></div><button type="button" class="refresh-button" data-action="refresh-venues" ${state.venueLoading ? 'disabled' : ''}><span class="refresh-symbol ${state.venueLoading ? 'spin' : ''}" aria-hidden="true">↻</span><span>${state.venueLoading ? '读取中' : '刷新目录'}</span></button></div>${state.venueError ? `<div class="warning-bar" role="status">${escapeHtml(state.venueError)}</div>` : ''}${state.venueLoading ? '<div class="info-note" role="status">正在读取公开场馆目录…</div>' : ''}<section class="surface-section venue-query"><div class="section-title"><div><span class="kicker">公开查询</span><h2>选择场馆</h2></div><span class="section-meta">${catalog?.counts?.venues || venues.length || 0} 个场馆</span></div>${catalog ? `<div class="venue-query-grid"><label class="field compact-field"><span>校区</span><select class="control-select" data-venue-campus>${campusOptions || '<option value="">暂无校区</option>'}</select></label><label class="field compact-field"><span>场馆</span><select class="control-select" data-venue-id ${selected ? '' : 'disabled'}>${venueOptions || '<option value="">暂无场馆</option>'}</select></label><label class="field compact-field"><span>日期</span><input type="date" class="control-select" data-venue-date value="${escapeHtml(state.venueDate)}"></label></div><button type="button" class="primary-button venue-query-button" data-action="venue-query" ${state.venueQuerying || !selected ? 'disabled' : ''}><span>${state.venueQuerying ? '查询中' : '查询场地状态'}</span><span aria-hidden="true">⌕</span></button>` : emptyState(state.venueLoading ? '正在读取场馆目录' : '点击右上角刷新目录')}</section>${renderVenueResult(state.venueResult)}</section>`
}

async function loadVenueCatalog(force = false) {
  if (state.venueLoading || (!force && state.venueCatalog)) return
  const requestId = ++venueRequestEpoch
  state.venueLoading = true
  state.venueError = ''
  renderView()
  try {
    const catalog = await getMotionAdapter().discover()
    if (requestId !== venueRequestEpoch) return
    state.venueCatalog = catalog
    const firstCampus = catalog.campuses?.[0]?.id || ''
    if (!state.venueCampus || !catalog.campuses?.some((campus) => campus.id === state.venueCampus)) state.venueCampus = firstCampus
    const venues = venueListForCampus(catalog, state.venueCampus)
    if (!state.venueId || !venues.some((venue) => venue.id === state.venueId)) state.venueId = venues[0]?.id || ''
    if (!venues.length) state.venueError = catalog.errors?.length ? '场馆目录读取不完整，请稍后重试' : '公开页面暂未发现可查询场馆'
  } catch (error) {
    if (requestId === venueRequestEpoch) state.venueError = publicBasicError(error)
  } finally {
    if (requestId === venueRequestEpoch) {
      state.venueLoading = false
      renderView()
    }
  }
}

async function queryVenueStatus() {
  if (state.venueQuerying || !state.venueCatalog) return
  const venue = venueRecord(state.venueCatalog, state.venueId)
  if (!venue) return
  const requestId = ++venueRequestEpoch
  const query = { detailUrl: venue.detailUrl, date: state.venueDate || null, venue: venue.label || venue.activity }
  state.venueQuerying = true
  state.venueError = ''
  state.venueResult = null
  renderView()
  try {
    const result = await getMotionAdapter().queryStatus(query)
    if (requestId === venueRequestEpoch) state.venueResult = result
  } catch (error) {
    if (requestId === venueRequestEpoch) state.venueError = publicBasicError(error)
  } finally {
    if (requestId === venueRequestEpoch) {
      state.venueQuerying = false
      renderView()
    }
  }
}

function classroomOptions(domain, key, label) {
  const options = Array.isArray(domain?.options?.[key]) ? domain.options[key] : []
  const stateKey = key === 'xqh_id' ? 'freeCampus' : key === 'lh' ? 'freeBuilding' : 'freeClassroomType'
  return `<label class="field compact-field"><span>${label}</span><select class="control-select" data-filter-key="${stateKey}"><option value="">不限</option>${options.map((option) => `<option value="${escapeHtml(option.value)}" ${state.filters[stateKey] === option.value ? 'selected' : ''}>${escapeHtml(option.label || option.value)}</option>`).join('')}</select></label>`
}

function renderClassrooms() {
  const domain = extraDomain('free-classroom')
  const records = Array.isArray(domain?.records) ? domain.records : []
  const status = state.classroomSearching ? (state.classroomStatus || '正在查询空闲教室…') : state.classroomError
  return `<section class="page-section">${pageHeader('校园资源', '空闲教室', '选择时间和筛选条件，查询当前可用教室。')}${extraStatus('free-classroom')}${warningBar()}${status ? `<div class="${state.classroomError ? 'warning-bar' : 'info-note'}">${escapeHtml(status)}</div>` : ''}<section class="surface-section classroom-form"><div class="section-title"><div><span class="kicker">只读查询</span><h2>查询条件</h2></div><span class="section-meta">${records.length ? `${records.length} 个结果` : '未查询'}</span></div><div class="form-grid"><div class="term-filter-field">${termSelectionControls(state.data, 'freeTerm')}</div><label class="field compact-field"><span>周次</span><input data-free-input="freeWeeks" value="${escapeHtml(state.filters.freeWeeks)}" placeholder="如 1,2,3"></label><label class="field compact-field"><span>星期</span><input data-free-input="freeWeekdays" value="${escapeHtml(state.filters.freeWeekdays)}" placeholder="如 1,3,5"></label><label class="field compact-field"><span>节次</span><input data-free-input="freePeriods" value="${escapeHtml(state.filters.freePeriods)}" placeholder="如 1,2,3"></label>${classroomOptions(domain, 'xqh_id', '校区')}${classroomOptions(domain, 'lh', '楼宇')}${classroomOptions(domain, 'cdlb_id', '教室类型')}<label class="field compact-field"><span>最少座位</span><input type="number" min="0" data-free-input="freeMinSeats" value="${escapeHtml(state.filters.freeMinSeats)}" placeholder="不限"></label><label class="field compact-field"><span>最多座位</span><input type="number" min="0" data-free-input="freeMaxSeats" value="${escapeHtml(state.filters.freeMaxSeats)}" placeholder="不限"></label></div><button class="primary-button classroom-search" data-action="classroom-search" ${state.classroomSearching ? 'disabled' : ''}><span>${state.classroomSearching ? '查询中' : '查询空闲教室'}</span><span aria-hidden="true">⌕</span></button></section><div class="classroom-results">${records.map(recordCard).join('') || emptyState(domain ? '填写条件后查询空闲教室' : '空闲教室数据域尚未读取')}</div></section>`
}

function csvNumbers(value, maximum) {
  return String(value || '').split(/[,，\s]+/u).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1 && item <= maximum)
}

async function searchClassrooms() {
  if (state.classroomSearching || !state.campus) return
  const campus = state.campus
  const epoch = authEpoch
  document.querySelectorAll('[data-free-input]').forEach((input) => { state.filters[input.dataset.freeInput] = input.value })
  state.classroomSearching = true
  state.classroomQueried = true
  state.classroomError = ''
  delete state.extraErrors['free-classroom']
  state.classroomStatus = '正在查询空闲教室…'
  renderView()
  try {
    const data = state.data || {}
    const term = selectedTerm(data, 'freeTerm')
    const values = state.filters
    const result = await campus.adapter.sync({
      domains: ['profile', 'terms', 'free-classroom'],
      includeAcademicExtras: false,
      freeClassroom: {
        term,
        weeks: csvNumbers(values.freeWeeks, 64),
        weekdays: csvNumbers(values.freeWeekdays, 7),
        periods: csvNumbers(values.freePeriods, 16),
        campus: values.freeCampus,
        building: values.freeBuilding,
        classroomType: values.freeClassroomType,
        minSeats: values.freeMinSeats,
        maxSeats: values.freeMaxSeats,
      },
    })
    if (!authIsCurrent(epoch) || state.campus !== campus) return
    const outcome = result?.domainOutcomes?.['free-classroom']
    const domainValue = result?.academicExtras?.domains?.['free-classroom']
    if ((outcome?.status === 'failed' || outcome?.succeeded === false) && !domainValue) {
      state.extraLoaded.delete('free-classroom')
      state.extraErrors['free-classroom'] = publicBasicError(result?.errors?.[0] || '空闲教室数据读取失败')
    } else {
      state.data = buildBasicData({ ...result, errors: [] }, campus.username, state.data)
      state.extraLoaded.add('free-classroom')
      if (Array.isArray(result?.errors) && result.errors.length) state.extraErrors['free-classroom'] = publicBasicError(result.errors[0])
    }
  } catch (error) {
    if (authIsCurrent(epoch) && state.campus === campus) state.classroomError = publicBasicError(error)
  } finally {
    if (state.campus === campus) {
      state.classroomSearching = false
      state.classroomStatus = ''
      renderApp()
    }
  }
}

async function refresh() {
  if (state.refreshing || state.classroomSearching || !state.campus) return
  const campus = state.campus
  const epoch = authEpoch
  const domain = extraDomainForView(state.view)
  state.refreshing = true
  state.error = ''
  renderView()
  try {
    if (domain) {
      if (domain === 'free-classroom' && state.classroomQueried) await searchClassrooms()
      else await loadExtraDomain(domain, { force: true })
    } else {
      const result = await syncWithAcademicRecovery(campus, epoch)
      if (authIsCurrent(epoch) && state.campus === campus) {
        state.data = buildBasicData(result, campus.username, state.data)
        if (state.academicCalendarAssets.manifest?.calendar) state.data = { ...state.data, academicCalendar: state.academicCalendarAssets.manifest.calendar }
        await persistSession(campus)
      }
    }
  } catch (error) {
    if (authIsCurrent(epoch) && state.campus === campus) state.error = publicBasicError(error)
  } finally {
    if (state.campus === campus) {
      state.refreshing = false
      renderApp()
    }
  }
}

async function logout() {
  authEpoch += 1
  venueRequestEpoch += 1
  state.loading = false
  state.refreshing = false
  state.authenticating = false
  state.authMode = ''
  state.campus = null
  state.data = null
  state.theolData = { courses: [], assignments: [], notices: [] }
  state.theolLoaded.clear()
  state.theolError = ''
  state.theolAuthRequired = false
  state.theolLoading = false
  state.extraLoading.clear()
  state.extraLoaded.clear()
  state.extraErrors = {}
  state.classroomSearching = false
  state.classroomQueried = false
  state.classroomStatus = ''
  state.error = ''
  state.classroomError = ''
  state.venueCatalog = null
  state.venueLoading = false
  state.venueQuerying = false
  state.venueError = ''
  state.venueResult = null
  state.authError = ''
  state.restoringSession = false
  state.viewHistory = []
  state.gradeDetailOpen.clear()
  state.gradeDetailPending = ''
  state.planPdfOpening = false
  state.planPdfError = ''
  if (state.planPdfUrl) URL.revokeObjectURL(state.planPdfUrl)
  state.planPdfUrl = ''
  state.academicCalendarPdfOpening = ''
  state.academicCalendarPdfError = ''
  state.view = 'overview'
  renderApp()
  await clearCasSession().catch(() => {})
  await clearPersistedSession()
}

window.addEventListener('resize', scheduleMapLayoutPass, { passive: true })
window.addEventListener('orientationchange', scheduleMapLayoutPass, { passive: true })
renderApp()
void loadAcademicCalendarAssets()
void restoreSavedSession()
