/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ClientRequest, IncomingMessage } from 'electron'
import type { RequestOptions } from 'node:http'

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0],
    private readonly productSource?: string) {
    super(proxyLogin)
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  private assertSource(options: RequestOptions): void {
    if (this.productSource === undefined) return
    const source = new URL(this.productSource)
    const address = new URL(`${options.protocol ?? 'https:'}//${options.hostname ?? options.host}${options.port === undefined ? '' : `:${options.port}`}${options.path ?? '/'}`)
    const headers = options.headers
    const host = headers !== undefined && 'Host' in headers ? headers.Host : headers !== undefined &&
      'host' in headers ? headers.host : undefined
    if (Array.isArray(headers)) throw new Error('更新请求头格式无效')
    if (address.protocol !== 'https:' || address.origin !== source.origin || !address.pathname.startsWith(source.pathname)
      || /%2f|%5c|%2e/iu.test(address.pathname)
      || address.username || address.password || options.auth || host !== undefined && host !== source.host) {
      throw new Error('更新地址与当前产品部署不匹配')
    }
  }

  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    this.assertSource(options)
    return super.createRequest({ ...options, ...(this.productSource === undefined ? {} : { redirect: 'manual' }) }, callback)
  }

  protected override addRedirectHandlers(request: ClientRequest, options: RequestOptions, reject: (error: Error) => void,
    redirectCount: number, handler: (options: RequestOptions) => void): void {
    super.addRedirectHandlers(request, options, reject, redirectCount, (next) => {
      try { this.assertSource(next); handler(next) }
      catch (_untrustedRedirect) { reject(new Error('更新重定向与当前产品部署不匹配')) }
    })
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    const stop = (): void => {
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
