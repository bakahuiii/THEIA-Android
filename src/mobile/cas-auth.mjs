import { registerPlugin } from '@capacitor/core'

const CasAuth = registerPlugin('CasAuth')

export async function openCasLogin(url, options = {}) {
  if (!window.Capacitor?.isNativePlatform?.()) {
    throw new Error('统一身份认证登录仅支持 Android App，请使用 APK 登录')
  }
  return CasAuth.login({
    url,
    ...(options.cookieHeader ? { cookieHeader: String(options.cookieHeader) } : {}),
    ...(options.academicCookieHeader ? { academicCookieHeader: String(options.academicCookieHeader) } : {}),
    ...(options.automaticCas ? { automaticCas: true } : {}),
  })
}

export async function openTheolLogin(url, options = {}) {
  if (!window.Capacitor?.isNativePlatform?.()) {
    throw new Error('课程平台登录仅支持 Android App，请使用 APK 登录')
  }
  return CasAuth.login({
    url,
    ...(options.cookieHeader ? { cookieHeader: String(options.cookieHeader) } : {}),
    ...(options.academicCookieHeader ? { academicCookieHeader: String(options.academicCookieHeader) } : {}),
    ...(options.theolCookieHeader ? { theolCookieHeader: String(options.theolCookieHeader) } : {}),
    ...(options.automaticTheol ? { automaticTheol: true } : {}),
  })
}

export async function getCasSessionCookies() {
  if (!window.Capacitor?.isNativePlatform?.()) return {}
  return CasAuth.getCookies()
}

export async function saveCasSession(value) {
  if (!window.Capacitor?.isNativePlatform?.()) return false
  await CasAuth.saveSession({ value: String(value || '') })
  return true
}

export async function readCasSession() {
  if (!window.Capacitor?.isNativePlatform?.()) return ''
  const result = await CasAuth.getSavedSession()
  return String(result?.value || '')
}

export async function clearSavedCasSession() {
  if (!window.Capacitor?.isNativePlatform?.()) return
  await CasAuth.clearSavedSession()
}

export async function clearCasSession() {
  if (!window.Capacitor?.isNativePlatform?.()) return
  await CasAuth.clearSession()
}
