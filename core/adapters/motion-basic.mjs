import * as cheerio from 'cheerio'
import { stableId } from '../util.mjs'

export const MOTION_BASE_URL = 'https://motion.buct.edu.cn/changguanyuyue1/'
export const MOTION_ENTRY_URL = `${MOTION_BASE_URL}xzxq.php`

const ALLOWED_PATHS = new Set([
  '/changguanyuyue1/xzxq.php',
  '/changguanyuyue1/jinri_cpxq.php',
  '/changguanyuyue1/jinri_dxq.php',
  '/changguanyuyue1/jinri_cl.php',
  '/changguanyuyue1/detail.php',
  '/changguanyuyue1/detailBB.php',
  '/changguanyuyue1/detail_cl.php',
])
const LISTING_PATHS = new Set([
  '/changguanyuyue1/xzxq.php',
  '/changguanyuyue1/jinri_cpxq.php',
  '/changguanyuyue1/jinri_dxq.php',
  '/changguanyuyue1/jinri_cl.php',
])
const DETAIL_PATH = /\/detail(?:BB|_cl)?\.php$/u
const ALLOWED_QUERY_KEYS = new Set(['XQ', 'xq', 'xm', 'd', 'c'])
const LOGIN_MARKER = /(?:统一认证|登录|登陆|用户名|口令|密码|captcha|验证码|username|password)/iu
const SENSITIVE_LABEL = /(?:姓名|学号|手机号|手机号码|手机|电话|身份证|联系人|预约人|申请人|用户名|账号|email|e-mail|phone|mobile|student|user(?:name)?|idcard)/iu
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/u
const TIME_RANGE = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/u

const text = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim()
const unique = (values) => [...new Set(values.filter(Boolean))]

function isCalendarDate(value) {
  if (!DATE_VALUE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function publicValue(value) {
  const normalized = text(value)
  return Boolean(normalized) && normalized.length <= 120 && !/[\u0000-\u001f<>]/u.test(normalized)
}

function sanitize(value) {
  const normalized = text(value)
  if (!normalized || SENSITIVE_LABEL.test(normalized)) return null
  return normalized.slice(0, 500)
}

function campusFromUrl(url, fallback = null) {
  const value = url.searchParams.get('XQ') || url.searchParams.get('xq')
  if (value === '0') return { id: 'changping', label: '昌平校区' }
  if (value === '1') return { id: 'east', label: '东校区' }
  return fallback
}

function campusFromLabel(value, fallback = null) {
  const normalized = text(value)
  if (/昌平/u.test(normalized)) return { id: 'changping', label: '昌平校区' }
  if (/东校区/u.test(normalized)) return { id: 'east', label: '东校区' }
  return fallback
}

function canonicalUrl(value) {
  let url
  try { url = new URL(String(value), MOTION_BASE_URL) } catch { return null }
  if (url.origin !== new URL(MOTION_BASE_URL).origin || !ALLOWED_PATHS.has(url.pathname)) return null
  const seen = new Set()
  for (const [key, value] of url.searchParams.entries()) {
    if (seen.has(key) || !ALLOWED_QUERY_KEYS.has(key) || !value || value.length > 120) return null
    seen.add(key)
    if ((key === 'XQ' || key === 'xq') && !/^[01]$/u.test(value)) return null
    if (key === 'd' && !isCalendarDate(value)) return null
    if (key === 'c' && !publicValue(value)) return null
  }
  url.hash = ''
  return url.toString()
}

function pageKind(pathname) {
  if (pathname.endsWith('/xzxq.php')) return 'campus-selector'
  if (pathname.endsWith('/jinri_cpxq.php') || pathname.endsWith('/jinri_dxq.php')) return 'campus-catalog'
  if (pathname.endsWith('/jinri_cl.php')) return 'morning-catalog'
  return 'venue-detail'
}

function selectedOptions($, name) {
  const select = $(`select[name="${name}"]`).first()
  if (!select.length) return { selected: null, values: [] }
  const values = select.find('option').toArray().map((node) => {
    const option = $(node)
    const value = sanitize(option.attr('value') || option.text())
    return { value, selected: option.attr('selected') !== undefined || option.is(':selected') }
  }).filter((option) => option.value)
  return { selected: values.find((option) => option.selected)?.value || values[0]?.value || null, values: unique(values.map((item) => item.value)) }
}

function resolvePublicOption(requested, available, label) {
  if (!requested) return available.selected
  if (!available.values.length || available.values.includes(requested)) return requested
  if (label === 'venue') {
    const match = available.values.find((value) => value.includes(requested) || requested.includes(value))
    if (match) return match
  }
  throw new Error(`该${label === 'venue' ? '场馆' : '日期'}未出现在公开选项中`)
}

function stateFor(value) {
  const normalized = text(value)
  if (/(?:可预约|可用|空闲)/u.test(normalized)) return 'available'
  if (/(?:已预约|已占用|上课|占用|已满)/u.test(normalized)) return 'occupied'
  if (/(?:闭馆|停用|不可用)/u.test(normalized)) return 'closed'
  if (/已过期/u.test(normalized)) return 'expired'
  if (/选定/u.test(normalized)) return 'selected'
  return 'unknown'
}

function extractAvailability($) {
  return $('table').toArray().map((node, index) => {
    const table = $(node)
    const headerNodes = table.find('thead th, thead td').toArray()
    const firstRow = table.find('tr').first()
    const headers = (headerNodes.length ? headerNodes : firstRow.find('th,td').toArray()).map((cell) => sanitize($(cell).text())).filter(Boolean)
    const slots = table.find('tr').toArray().map((row) => {
      const cells = $(row).find('th,td').toArray()
      const time = sanitize($(cells[0]).text())
      if (!time || !TIME_RANGE.test(time)) return null
      const courts = cells.slice(1).map((cell, cellIndex) => {
        const court = headers[cellIndex + 1] || `场地 ${cellIndex + 1}`
        const status = sanitize($(cell).text())
        if (!status || SENSITIVE_LABEL.test(court)) return null
        return { court, status, state: stateFor(status) }
      }).filter(Boolean)
      return courts.length ? { time, courts } : null
    }).filter(Boolean)
    if (!slots.length) return null
    return { index, headers: [headers[0] || '时间/场地', ...headers.slice(1)], slots }
  }).filter(Boolean)
}

async function requestPage(fetchImpl, url) {
  const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml' } })
  const status = Number(response.status) || 0
  const body = await response.text()
  if (!response.ok || status < 200 || status >= 300) throw new Error(`MOTION HTTP ${status || 'unknown'}`)
  let responseUrl = url
  try {
    const candidate = new URL(String(response.url || url))
    if (candidate.origin === new URL(MOTION_BASE_URL).origin) responseUrl = candidate.toString()
  } catch { /* use the requested public URL when a development proxy hides it */ }
  const finalUrl = canonicalUrl(responseUrl)
  if (!finalUrl) throw new Error('MOTION 响应超出公开地址范围')
  return { body, status, contentType: response.headers?.get?.('content-type') || null, finalUrl }
}

function discoveredLinks($, pageUrl, fallbackCampus) {
  const links = []
  $('a[href]').each((_index, node) => {
    let candidate = null
    try { candidate = canonicalUrl(new URL($(node).attr('href'), pageUrl).toString()) } catch { /* ignore malformed public links */ }
    if (!candidate) return
    const parsed = new URL(candidate)
    const currentPath = new URL(pageUrl).pathname
    const allowed = pageUrl.endsWith('/xzxq.php')
      ? parsed.pathname.endsWith('/jinri_cpxq.php') || parsed.pathname.endsWith('/jinri_dxq.php')
      : LISTING_PATHS.has(currentPath)
        ? DETAIL_PATH.test(parsed.pathname) || parsed.pathname.endsWith('/jinri_cl.php')
        : false
    if (!allowed) return
    links.push({ url: candidate, label: sanitize($(node).text() || $(node).attr('title')), campus: campusFromLabel($(node).text(), fallbackCampus) })
  })
  return links
}

export class MotionVenueAdapter {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('MotionVenueAdapter requires fetchImpl')
    this.fetchImpl = fetchImpl
  }

  async discover() {
    const queue = [{ url: MOTION_ENTRY_URL, campus: null }]
    const seen = new Set()
    const pages = []
    const links = []
    const errors = []
    while (queue.length) {
      const current = queue.shift()
      if (seen.has(current.url)) continue
      seen.add(current.url)
      try {
        const response = await requestPage(this.fetchImpl, current.url)
        const $ = cheerio.load(response.body)
        const parsedUrl = new URL(response.finalUrl)
        const campus = campusFromUrl(parsedUrl, current.campus)
        if (LOGIN_MARKER.test(`${$('title').first().text()} ${$('body').text().slice(0, 2000)}`)) throw new Error('MOTION 页面需要登录')
        pages.push({ kind: pageKind(parsedUrl.pathname), url: response.finalUrl, status: response.status })
        for (const link of discoveredLinks($, response.finalUrl, campus)) {
          links.push({ ...link, sourceUrl: response.finalUrl })
          if (!seen.has(link.url)) queue.push({ url: link.url, campus: link.campus || campus })
        }
      } catch (error) {
        errors.push({ url: current.url, message: String(error?.message || error).slice(0, 300) })
      }
    }
    const venues = [...new Map(links.filter((link) => DETAIL_PATH.test(new URL(link.url).pathname)).map((link) => {
      const parsed = new URL(link.url)
      const campus = link.campus || campusFromUrl(parsed, { id: 'unknown', label: '未标注校区' })
      const activity = sanitize(parsed.searchParams.get('xm') || link.label) || '未命名项目'
      return [link.url, { id: `motion-venue-${stableId(campus.id, activity, link.url).slice(0, 20)}`, campusId: campus.id, campusLabel: campus.label, activity, label: link.label || activity, detailUrl: link.url }]
    })).values()]
    const campuses = [...new Map(venues.map((venue) => [venue.campusId, { id: venue.campusId, label: venue.campusLabel }])).values()]
      .map((campus) => ({ ...campus, venueIds: venues.filter((venue) => venue.campusId === campus.id).map((venue) => venue.id) }))
    return { schema: 'theia-motion-venue-catalog/v1', capturedAt: new Date().toISOString(), source: { platform: 'MOTION', accessMode: 'public-anonymous-get', entryUrl: MOTION_ENTRY_URL, method: 'GET' }, counts: { pages: pages.length, venues: venues.length, campuses: campuses.length, errors: errors.length }, campuses, venues, pages, errors }
  }

  async queryStatus({ detailUrl, date = null, venue = null } = {}) {
    const sourceUrl = canonicalUrl(detailUrl)
    if (!sourceUrl || !DETAIL_PATH.test(new URL(sourceUrl).pathname)) throw new Error('MOTION 场馆地址无效')
    const initial = await requestPage(this.fetchImpl, sourceUrl)
    const $initial = cheerio.load(initial.body)
    if (LOGIN_MARKER.test(`${$initial('title').first().text()} ${$initial('body').text().slice(0, 2000)}`)) throw new Error('MOTION 页面需要登录')
    const availableDate = selectedOptions($initial, 'd')
    const availableVenue = selectedOptions($initial, 'c')
    const requestedDate = resolvePublicOption(date == null ? availableDate.selected : String(date), availableDate, 'date')
    const requestedVenue = resolvePublicOption(venue == null ? availableVenue.selected : String(venue), availableVenue, 'venue')
    if (!requestedDate || !isCalendarDate(requestedDate)) throw new Error('没有可查询的日期')
    if (!requestedVenue || !publicValue(requestedVenue)) throw new Error('没有可查询的场馆')
    const target = new URL(initial.finalUrl || sourceUrl)
    target.searchParams.set('d', requestedDate)
    target.searchParams.set('c', requestedVenue)
    const queryUrl = canonicalUrl(target.toString())
    if (!queryUrl) throw new Error('场馆查询地址无效')
    const selected = availableDate.selected === requestedDate && availableVenue.selected === requestedVenue ? initial : await requestPage(this.fetchImpl, queryUrl)
    const $ = cheerio.load(selected.body)
    const selectedDate = selectedOptions($, 'd').selected || requestedDate
    const selectedVenue = selectedOptions($, 'c').selected || requestedVenue
    if (selectedDate !== requestedDate || selectedVenue !== requestedVenue) throw new Error('场馆页面没有确认查询条件')
    const tables = extractAvailability($)
    const cells = tables.flatMap((table) => table.slots.flatMap((slot) => slot.courts))
    const byState = Object.fromEntries([...new Set(cells.map((cell) => cell.state))].map((key) => [key, cells.filter((cell) => cell.state === key).length]))
    const parsedUrl = new URL(selected.finalUrl || queryUrl)
    return { schema: 'theia-motion-venue-status/v1', capturedAt: new Date().toISOString(), source: { platform: 'MOTION', accessMode: 'public-anonymous-get', url: selected.finalUrl || queryUrl, method: 'GET', contentType: selected.contentType }, query: { activity: sanitize(parsedUrl.searchParams.get('xm')), campus: campusFromUrl(parsedUrl), detailUrl: sourceUrl, date: selectedDate, venue: selectedVenue, availableDates: availableDate.values, availableVenues: availableVenue.values }, availability: { tables, summary: { timeSlots: tables.reduce((total, table) => total + table.slots.length, 0), courtStatusCells: cells.length, byState } }, safety: { onlyRead: true, requestedMethods: ['GET'], submittedForms: 0, executedBookingActions: 0, credentialsOrCookiesSupplied: false, rawBodyPersisted: false } }
  }
}
