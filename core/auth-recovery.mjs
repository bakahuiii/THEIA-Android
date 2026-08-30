export function isAcademicAuthFailure(error) {
  const message = String(error?.message || error || '')
  return error?.name === 'AuthRequiredError'
    || Number(error?.code) === 1006
    || /(?:Academic system|教务)(?:[^\r\n]{0,80})(?:需要重新完成统一身份认证|会话已失效|登录页)/iu.test(message)
}

export async function syncWithRecovery({ mode, sync, recover, onRecover = () => {} }) {
  try {
    return await sync()
  } catch (error) {
    if (mode !== 'cas' || !isAcademicAuthFailure(error)) throw error
    onRecover()
    if (!await recover()) throw error
    return sync()
  }
}
