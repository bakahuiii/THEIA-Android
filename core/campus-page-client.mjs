import iconv from 'iconv-lite'
import { compactError, htmlLooksLikeLogin, parseCookieHeader, parseSetCookie, splitSetCookieHeader } from './util.mjs'
import { permittedSourceUrl } from './source-url-policy.mjs'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5
const MAX_TEXT_RESPONSE_BYTES = 16 * 1024 * 1024
const MAX_BINARY_RESPONSE_BYTES = 32 * 1024 * 1024

function decode(buffer, contentType) {
  const charset = String(contentType || '').match(/charset\s*=\s*["']?([^;"']+)/i)?.[1]?.toLowerCase()
  if (charset && !['utf-8', 'utf8'].includes(charset)) {
    try { return iconv.decode(buffer, charset) } catch { /* fall through */ }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

function withTimeout(factory, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback(value)
    }
    const timer = setTimeout(() => {
      onTimeout?.()
      const error = new Error('校园网页请求超时')
      error.name = 'TimeoutError'
      finish(reject, error)
    }, Math.max(1000, Number(timeoutMs) || 30_000))
    Promise.resolve().then(factory).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    )
  })
}

async function readText(response) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_TEXT_RESPONSE_BYTES) throw new Error('校园网页响应超过 16 MB 限制')
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > MAX_TEXT_RESPONSE_BYTES) throw new Error('校园网页响应超过 16 MB 限制')
  return decode(buffer, response.headers.get('content-type') || '')
}

export class CampusPageClient {
  constructor({ cookieHeader = '', fetchImpl = fetch, requestUrl = null, timeoutMs = 30_000, onDiagnostic = () => {} } = {}) {
    this.fetch = fetchImpl
    this.requestUrl = typeof requestUrl === 'function' ? requestUrl : (url) => url
    this.timeoutMs = timeoutMs
    this.cookies = new Map()
    this.setCookieHeader(cookieHeader)
    this.onDiagnostic = typeof onDiagnostic === 'function' ? onDiagnostic : () => {}
  }

  cookieHeader() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }

  setCookieHeader(value) {
    for (const [name, cookieValue] of parseCookieHeader(value)) {
      if (cookieValue) this.cookies.set(name, cookieValue)
      else this.cookies.delete(name)
    }
    return this.cookieHeader()
  }

  absorbCookies(headers) {
    const values = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get('set-cookie'))
    values.flatMap((value) => splitSetCookieHeader(value)).forEach((value) => {
      const parsed = parseSetCookie(value)
      if (!parsed) return
      if (parsed.deleted) this.cookies.delete(parsed.name)
      else this.cookies.set(parsed.name, parsed.value)
    })
  }

  async request(url, init = {}, redirects = 0, timeoutMs = this.timeoutMs, responseType = 'text') {
    if (redirects > MAX_REDIRECTS) throw new Error('校园网页重定向过多')
    const target = permittedSourceUrl(url)
    const controller = new AbortController()
    const callerSignal = init.signal
    const abortFromCaller = () => controller.abort()
    if (callerSignal?.aborted) {
      const error = new Error('请求已取消')
      error.name = 'AbortError'
      throw error
    }
    callerSignal?.addEventListener?.('abort', abortFromCaller, { once: true })
    const requestTimeout = Math.max(1000, Number(timeoutMs) || this.timeoutMs)
    try {
      const headers = new Headers(init.headers || {})
      headers.set('Accept-Language', 'zh-CN,zh;q=0.9,en;q=0.4')
      if (this.cookies.size && !headers.has('Cookie')) headers.set('Cookie', this.cookieHeader())
      this.onDiagnostic('campus_page.request_started', { url: target, method: init.method || 'GET' })
      const response = await withTimeout(() => this.fetch(this.requestUrl(target), {
        ...init,
        headers,
        credentials: 'include',
        redirect: 'manual',
        signal: controller.signal,
      }), requestTimeout, () => controller.abort())
      this.absorbCookies(response.headers)
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error('校园网页返回了无目标的重定向')
        const next = permittedSourceUrl(new URL(location, target).toString())
        const method = String(init.method || 'GET').toUpperCase()
        const nextInit = { ...init }
        if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
          nextInit.method = 'GET'
          delete nextInit.body
          const nextHeaders = new Headers(nextInit.headers || {})
          nextHeaders.delete('Content-Type')
          nextHeaders.delete('Content-Length')
          nextInit.headers = nextHeaders
        }
        return this.request(next, nextInit, redirects + 1, requestTimeout, responseType)
      }
      if (responseType === 'binary') {
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_BINARY_RESPONSE_BYTES) throw new Error('校园网页二进制响应超过 32 MB 限制')
        const buffer = new Uint8Array(await withTimeout(() => response.arrayBuffer(), requestTimeout, () => controller.abort()))
        if (buffer.length > MAX_BINARY_RESPONSE_BYTES) throw new Error('校园网页二进制响应超过 32 MB 限制')
        const contentType = response.headers.get('content-type') || ''
        const leadingText = /(?:html|json|text)/i.test(contentType)
          || String.fromCharCode(...buffer.subarray(0, Math.min(buffer.length, 64))).trimStart().startsWith('<')
        const text = leadingText ? decode(buffer.subarray(0, Math.min(buffer.length, 64 * 1024)), contentType) : ''
        if (!response.ok) throw new Error(`校园网页请求失败 (${response.status})`)
        this.onDiagnostic('campus_page.request_finished', { url: target, method: init.method || 'GET', status: response.status, bytes: buffer.length, responseType })
        return { buffer, text, url: target, headers: response.headers }
      }
      const text = await withTimeout(() => readText(response), requestTimeout, () => controller.abort())
      if (!response.ok) throw new Error(`校园网页请求失败 (${response.status})`)
      this.onDiagnostic('campus_page.request_finished', { url: target, method: init.method || 'GET', status: response.status, bytes: text.length })
      return { text, url: target, headers: response.headers }
    } catch (error) {
      if (callerSignal?.aborted) {
        const cancelled = new Error('请求已取消')
        cancelled.name = 'AbortError'
        throw cancelled
      }
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw new Error('校园网页请求超时')
      if (error instanceof TypeError) throw new Error(`校园网页网络错误：${compactError(error)}`)
      throw error
    } finally {
      callerSignal?.removeEventListener?.('abort', abortFromCaller)
    }
  }

  async page(url, { source = '校园网页', timeoutMs, signal } = {}) {
    const result = await this.request(url, { signal }, 0, timeoutMs)
    if (htmlLooksLikeLogin(result.text, result.url)) throw new Error(`${source} 会话已失效`)
    return result
  }

  async json(url, { source = '校园网页', timeoutMs, signal } = {}) {
    const result = await this.request(url, { signal }, 0, timeoutMs)
    if (htmlLooksLikeLogin(result.text, result.url)) throw new Error(`${source} 会话已失效`)
    try { return JSON.parse(result.text) } catch { throw new Error(`${source} 返回了无法解析的数据`) }
  }

  async binary(url, { source = '校园附件', timeoutMs, signal } = {}) {
    const result = await this.request(url, { signal }, 0, timeoutMs, 'binary')
    if (result.text && htmlLooksLikeLogin(result.text, result.url)) throw new Error(`${source} 会话已失效`)
    return result
  }
}
