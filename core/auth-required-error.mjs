export class AuthRequiredError extends Error {
  constructor(source, url) {
    super(`${source} 需要重新完成统一身份认证`)
    this.name = 'AuthRequiredError'
    this.source = source
    this.url = url
  }
}

