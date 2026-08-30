import { OFFICIAL_ACADEMIC_CALENDAR, currentAcademicWeek, nextAcademicCalendarBoundary } from '../../core/academic-calendar.mjs'
import {
  ACADEMIC_CALENDAR_ANALYSIS_SCHEMA,
  ACADEMIC_CALENDAR_PARSER_VERSION,
  academicTrackContextKey,
  mergeWeeklyCalendarIntoAcademicCalendar,
  parseTeachingScheduleText,
  parseWeeklyCalendarText,
} from '../../core/academic-calendar-analysis.mjs'

export const ACADEMIC_CALENDAR_PAGES = Object.freeze({
  calendar: 'https://jiaowuchu.buct.edu.cn/2019/1125/c3201a46856/page.htm',
  teachingSchedule: 'https://jiaowuchu.buct.edu.cn/2019/1125/c3207a46873/page.htm',
  weeklyCalendar: 'https://jiaowuchu.buct.edu.cn/2019/1125/c3199a46850/page.htm',
})

const BASE_URL = 'https://jiaowuchu.buct.edu.cn'
const FILES = Object.freeze({ calendar: 'calendar_current.jpg', teachingSchedule: 'teaching_schedule_current.pdf', weeklyCalendar: 'weekly_calendar_current.pdf' })
const SCHEMA = 'theia-basic-academic-calendar-assets/v1'
const DB_NAME = 'theia-basic.academic-calendar.v1'
const META_STORE = 'meta'
const ASSET_STORE = 'assets'
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const MAX_PDF_BYTES = 32 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function isoDate(value = new Date()) {
  return new Date(value).toISOString()
}

function emptyManifest() {
  return {
    schema: SCHEMA,
    updatedAt: null,
    assets: {},
    calendar: { ...OFFICIAL_ACADEMIC_CALENDAR },
    calendarError: null,
    analysis: null,
    analysisError: null,
    resourceErrors: {},
  }
}

function bytesOf(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return new Uint8Array(value || [])
}

function copyManifest(value) {
  try { return JSON.parse(JSON.stringify(value)) } catch { return emptyManifest() }
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('校历缓存读取失败'))
  })
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('校历缓存写入失败'))
    transaction.onabort = () => reject(transaction.error || new Error('校历缓存写入已取消'))
  })
}

function createCache() {
  const memoryMeta = new Map()
  const memoryAssets = new Map()
  let databasePromise = null
  const indexed = typeof globalThis.indexedDB !== 'undefined'

  function database() {
    if (!indexed) return Promise.resolve(null)
    if (databasePromise) return databasePromise
    databasePromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const databaseValue = request.result
        if (!databaseValue.objectStoreNames.contains(META_STORE)) databaseValue.createObjectStore(META_STORE, { keyPath: 'key' })
        if (!databaseValue.objectStoreNames.contains(ASSET_STORE)) databaseValue.createObjectStore(ASSET_STORE, { keyPath: 'key' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('校历缓存初始化失败'))
    }).catch(() => null)
    return databasePromise
  }

  async function getManifest() {
    const databaseValue = await database()
    if (!databaseValue) return memoryMeta.get('manifest') || null
    try {
      const transaction = databaseValue.transaction(META_STORE, 'readonly')
      const record = await requestResult(transaction.objectStore(META_STORE).get('manifest'))
      return record?.value || null
    } catch { return null }
  }

  async function putManifest(value) {
    const databaseValue = await database()
    if (!databaseValue) {
      memoryMeta.set('manifest', copyManifest(value))
      return
    }
    try {
      const transaction = databaseValue.transaction(META_STORE, 'readwrite')
      transaction.objectStore(META_STORE).put({ key: 'manifest', value: copyManifest(value) })
      await transactionResult(transaction)
    } catch {
      memoryMeta.set('manifest', copyManifest(value))
    }
  }

  async function getAsset(key) {
    const databaseValue = await database()
    if (!databaseValue) return memoryAssets.get(key) || null
    try {
      const transaction = databaseValue.transaction(ASSET_STORE, 'readonly')
      return await requestResult(transaction.objectStore(ASSET_STORE).get(key))
    } catch { return null }
  }

  async function putAsset(record) {
    const databaseValue = await database()
    if (!databaseValue) {
      memoryAssets.set(record.key, record)
      return
    }
    try {
      const transaction = databaseValue.transaction(ASSET_STORE, 'readwrite')
      transaction.objectStore(ASSET_STORE).put(record)
      await transactionResult(transaction)
    } catch {
      memoryAssets.set(record.key, record)
    }
  }

  return { getManifest, putManifest, getAsset, putAsset }
}

function absoluteSource(value) {
  const text = String(value || '').replace(/&amp;/gi, '&').trim()
  if (!text) return null
  try {
    const url = new URL(text, BASE_URL)
    // Some Android HTTP stacks expose a same-host canonical redirect as
    // http:// even though the original page was https://. Keep the request
    // on the trusted host and upgrade that redirect back to HTTPS.
    if (url.hostname.toLowerCase() !== new URL(BASE_URL).hostname.toLowerCase()) return null
    url.protocol = 'https:'
    url.port = ''
    return url.toString()
  } catch { return null }
}

function redirectLocation(response, baseUrl) {
  const headers = response?.headers
  let location = headers?.get?.('location') || headers?.get?.('Location') || ''
  if (!location && headers && typeof headers === 'object') {
    const entry = Object.entries(headers).find(([name]) => String(name).toLowerCase() === 'location')
    location = entry?.[1] || ''
  }
  if (!location) {
    const refresh = headers?.get?.('refresh') || headers?.get?.('Refresh') || ''
    location = String(refresh).match(/(?:^|;)\s*url\s*=\s*([^;]+)\s*$/iu)?.[1] || ''
  }
  const value = Array.isArray(location) ? location[0] : location
  const target = String(value || '').trim()
  if (!target) return null
  try { return absoluteSource(new URL(target, baseUrl).toString()) } catch { return null }
}

export function sourceUrlFromCalendarPage(html) {
  const values = [...String(html || '').matchAll(/(?:src|href|data-[\w-]+)\s*=\s*["']([^"']+)["']/giu)].map((match) => absoluteSource(match[1]))
  const image = values.find((value) => /\/_upload\/article\/images\/[^?#]+\.jpe?g(?:\?|$)/iu.test(value || ''))
  if (!image) throw new Error('校历页面没有发现高清图片')
  return image.replace(/\.jpe?g(?:\?.*)?$/iu, '_d.jpg')
}

export function sourceUrlFromPdfPage(html) {
  const values = [...String(html || '').matchAll(/(?:src|href|data-[\w-]+)\s*=\s*["']([^"']+)["']/giu)].map((match) => absoluteSource(match[1]))
  const pdf = values.find((value) => /\/_upload\/article\/files\/[^?#]+\.pdf(?:\?|$)/iu.test(value || ''))
  if (!pdf) throw new Error('教务页面没有发现 PDF')
  return pdf
}

function assetHasBytes(record) {
  return Boolean(record?.buffer && bytesOf(record.buffer).length)
}

function nextRefreshAfter(calendar) {
  const boundary = nextAcademicCalendarBoundary(calendar)
  return boundary ? `${boundary}T00:00:00.000Z` : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
}

function shouldProbe(entry, buffer, now, force) {
  if (force || !entry || !assetHasBytes(buffer)) return true
  const nextProbe = new Date(entry.nextProbeAfter || 0).getTime()
  const nextRefresh = new Date(entry.nextRefreshAfter || 0).getTime()
  return (Number.isFinite(nextProbe) && nextProbe <= now) || (Number.isFinite(nextRefresh) && nextRefresh <= now)
}

function resourceError(error) {
  return String(error?.message || error || '资源读取失败').replace(/[\r\n]+/gu, ' ').slice(0, 240) || '资源读取失败'
}

function contentTypeFor(key) {
  return key === 'calendar' ? 'image/jpeg' : 'application/pdf'
}

function validBytes(key, bytes) {
  if (!bytes.length) throw new Error('教务资源为空')
  if (key === 'calendar') {
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('校历图片超过 16 MB 限制')
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('校历图片内容无效')
  } else {
    if (bytes.length > MAX_PDF_BYTES) throw new Error('校历 PDF 超过 32 MB 限制')
    if (String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('教务页面返回的不是 PDF')
  }
  return bytes
}

async function withTimeout(task, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  try {
    const request = task(controller?.signal)
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new Error('校历资源请求超时')) }, timeoutMs) })
    return await Promise.race([request, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function createAcademicCalendarAssetsClient({
  fetchImpl = globalThis.fetch,
  requestUrl = (url) => url,
  pdfTextReader = null,
  profileProvider = () => null,
  coursesProvider = () => [],
  academicTrackProvider = () => null,
  onDiagnostic = () => {},
} = {}) {
  const cache = createCache()
  const buffers = new Map()
  const objectUrls = new Map()
  let manifest = emptyManifest()
  let loadPromise = null
  let refreshInFlight = null

  function snapshot() {
    const value = copyManifest(manifest)
    if (value.calendar) value.calendar.currentWeek = currentAcademicWeek(value.calendar)
    value.assetUrls = assetUrls()
    return value
  }

  function assetUrls() {
    const output = {}
    for (const key of Object.keys(FILES)) {
      const bytes = buffers.get(key)
      if (!bytes?.length || typeof URL?.createObjectURL !== 'function') continue
      let url = objectUrls.get(key)
      if (!url) {
        url = URL.createObjectURL(new Blob([bytes], { type: contentTypeFor(key) }))
        objectUrls.set(key, url)
      }
      output[key] = url
    }
    return output
  }

  function assetBuffer(key) {
    const bytes = buffers.get(key)
    return bytes?.length ? bytes.slice() : null
  }

  async function load() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      const saved = await cache.getManifest()
      if (saved?.schema === SCHEMA) manifest = { ...emptyManifest(), ...saved, resourceErrors: saved.resourceErrors || {} }
      for (const key of Object.keys(FILES)) {
        const record = await cache.getAsset(key)
        if (record?.buffer) buffers.set(key, bytesOf(record.buffer))
      }
      return snapshot()
    })().finally(() => { loadPromise = null })
    return loadPromise
  }

  function needsRefresh({ now = Date.now(), profile = profileProvider(), courses = coursesProvider(), academicTrack = academicTrackProvider() } = {}) {
    const context = { profile, courses, academicTrack }
    const analysisStale = Boolean(pdfTextReader && (
      !manifest.analysis
      || manifest.analysis.parserVersion !== ACADEMIC_CALENDAR_PARSER_VERSION
      || manifest.analysis.analysisError
      || manifest.analysisError
      || (buffers.get('weeklyCalendar')?.length && !manifest.analysis.weeklyCalendar)
      || (buffers.get('teachingSchedule')?.length && !manifest.analysis.teachingSchedule)
      || manifest.analysis.teachingSchedule?.contextKey !== academicTrackContextKey(context)
    ))
    return analysisStale || Object.keys(FILES).some((key) => shouldProbe(manifest.assets?.[key], { buffer: buffers.get(key) }, now, false))
  }

  async function request(url, binary = false, redirects = 0) {
    if (typeof fetchImpl !== 'function') throw new Error('当前环境不支持网络请求')
    if (redirects > 5) throw new Error('校历资源重定向过多')
    const logicalTarget = absoluteSource(url)
    if (!logicalTarget) throw new Error('校历资源地址不受信任')
    const target = requestUrl(logicalTarget)
    return withTimeout(async (signal) => {
      const response = await fetchImpl(target, {
        headers: { 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: binary ? '*/*' : 'text/html,application/xhtml+xml' },
        credentials: 'same-origin',
        ...(signal ? { signal } : {}),
      })
      if (REDIRECT_STATUSES.has(Number(response?.status))) {
        const next = redirectLocation(response, logicalTarget)
        if (!next) throw new Error(`校历资源返回 ${response.status}，但没有有效的教务处跳转地址`)
        return request(next, binary, redirects + 1)
      }
      if (!response?.ok) throw new Error(`教务资源请求失败（${response?.status || 0}）`)
      return binary ? bytesOf(await response.arrayBuffer()) : response.text()
    })
  }

  async function persist() {
    manifest.updatedAt = isoDate()
    await cache.putManifest(manifest)
  }

  async function refreshInternal({ force = false, profile = profileProvider(), courses = coursesProvider(), academicTrack = academicTrackProvider() } = {}) {
    await load()
    const now = Date.now()
    let changed = false
    const specs = [
      { key: 'calendar', page: ACADEMIC_CALENDAR_PAGES.calendar, source: sourceUrlFromCalendarPage },
      { key: 'teachingSchedule', page: ACADEMIC_CALENDAR_PAGES.teachingSchedule, source: sourceUrlFromPdfPage },
      { key: 'weeklyCalendar', page: ACADEMIC_CALENDAR_PAGES.weeklyCalendar, source: sourceUrlFromPdfPage },
    ]
    for (const spec of specs) {
      const previous = manifest.assets?.[spec.key]
      const currentBuffer = buffers.get(spec.key)
      if (!shouldProbe(previous, { buffer: currentBuffer }, now, force)) continue
      onDiagnostic('academic_calendar.probe_started', { key: spec.key, force })
      try {
        const page = await request(spec.page)
        const sourceUrl = spec.source(page)
        if (previous?.sourceUrl === sourceUrl && currentBuffer?.length) {
          manifest.assets[spec.key] = { ...previous, lastCheckedAt: isoDate(now), nextProbeAfter: isoDate(now + PROBE_INTERVAL_MS), nextRefreshAfter: spec.key === 'calendar' ? nextRefreshAfter(manifest.calendar) : nextRefreshAfter(manifest.calendar) }
          delete manifest.resourceErrors[spec.key]
          continue
        }
        const bytes = validBytes(spec.key, await request(sourceUrl, true))
        buffers.set(spec.key, bytes)
        await cache.putAsset({ key: spec.key, sourceUrl, buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), contentType: contentTypeFor(spec.key) })
        manifest.assets[spec.key] = { filename: FILES[spec.key], sourceUrl, bytes: bytes.length, fetchedAt: isoDate(now), lastCheckedAt: isoDate(now), nextProbeAfter: isoDate(now + PROBE_INTERVAL_MS), nextRefreshAfter: nextRefreshAfter(manifest.calendar) }
        delete manifest.resourceErrors[spec.key]
        changed = true
        onDiagnostic('academic_calendar.asset_finished', { key: spec.key, bytes: bytes.length })
      } catch (error) {
        manifest.resourceErrors[spec.key] = resourceError(error)
        onDiagnostic('academic_calendar.asset_failed', { key: spec.key, error: manifest.resourceErrors[spec.key] })
      }
    }

    const weeklyBuffer = buffers.get('weeklyCalendar')
    const teachingBuffer = buffers.get('teachingSchedule')
    const context = { profile, courses, academicTrack }
    const shouldAnalyze = Boolean(pdfTextReader && (
      force
      || changed
      || !manifest.analysis
      || manifest.analysis.parserVersion !== ACADEMIC_CALENDAR_PARSER_VERSION
      || manifest.analysisError
      || (weeklyBuffer?.length && !manifest.analysis.weeklyCalendar)
      || (teachingBuffer?.length && !manifest.analysis.teachingSchedule)
      || manifest.analysis.teachingSchedule?.contextKey !== academicTrackContextKey(context)
    ))
    if (shouldAnalyze) {
      onDiagnostic('academic_calendar.pdf_analysis_started', {})
      const previousAnalysis = manifest.analysis && typeof manifest.analysis === 'object' ? manifest.analysis : {}
      let weeklyCalendar = previousAnalysis.weeklyCalendar || null
      let teachingSchedule = previousAnalysis.teachingSchedule || null
      const analysisErrors = []
      if (weeklyBuffer?.length) {
        try {
          const weeklyText = await pdfTextReader(weeklyBuffer)
          const parsedWeeklyCalendar = weeklyText ? parseWeeklyCalendarText(weeklyText, { ...manifest.assets.weeklyCalendar }) : null
          if (parsedWeeklyCalendar) weeklyCalendar = parsedWeeklyCalendar
          else analysisErrors.push('工作周历 PDF 没有可解析文本')
        } catch (error) {
          analysisErrors.push(`工作周历：${resourceError(error)}`)
        }
      }
      if (teachingBuffer?.length) {
        try {
          const teachingText = await pdfTextReader(teachingBuffer)
          const parsedTeachingSchedule = teachingText
            ? { ...parseTeachingScheduleText(teachingText, { ...context }), contextKey: academicTrackContextKey(context) }
            : null
          if (parsedTeachingSchedule) teachingSchedule = parsedTeachingSchedule
          else analysisErrors.push('教学进程表 PDF 没有可解析文本')
        } catch (error) {
          analysisErrors.push(`教学进程表：${resourceError(error)}`)
        }
      }
      manifest.analysis = {
        schema: ACADEMIC_CALENDAR_ANALYSIS_SCHEMA,
        parserVersion: ACADEMIC_CALENDAR_PARSER_VERSION,
        updatedAt: isoDate(),
        weeklyCalendar,
        teachingSchedule,
      }
      if (weeklyCalendar) manifest.calendar = mergeWeeklyCalendarIntoAcademicCalendar(manifest.calendar || OFFICIAL_ACADEMIC_CALENDAR, weeklyCalendar)
      manifest.calendarError = null
      manifest.analysisError = analysisErrors.length ? analysisErrors.join('；').slice(0, 600) : null
      onDiagnostic(analysisErrors.length ? 'academic_calendar.pdf_analysis_partial' : 'academic_calendar.pdf_analysis_finished', {
        weeklyEntries: weeklyCalendar?.entries?.length || 0,
        teachingRows: teachingSchedule?.rows?.length || 0,
        errorCount: analysisErrors.length,
      })
    }
    await persist()
    return snapshot()
  }

  function refresh(options = {}) {
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = refreshInternal(options).finally(() => { refreshInFlight = null })
    return refreshInFlight
  }

  return {
    load,
    snapshot,
    assetUrls,
    assetBuffer,
    needsRefresh,
    refresh,
    get refreshInFlight() { return refreshInFlight },
  }
}

export const ACADEMIC_CALENDAR_ASSET_FILES = FILES
