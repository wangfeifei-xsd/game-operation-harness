/** 公开登录入口插件：严格同源认证接口和有背压的私有 Host 代理。 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import httpProxy from 'http-proxy'
import { HarnessAuthError } from './harness-auth-client.ts'
import { HarnessCoordinator } from './harness-coordinator.ts'
import type { HarnessConfig } from './harness-config.ts'
import { HARNESS_PRIVATE_HEADER } from './harness-private-auth.ts'

function reply(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}
function failure(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) return
  if (response.headersSent) { response.destroy(); return }
  const known = error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_UNAVAILABLE', '本地服务暂不可用，请重新登录')
  reply(response, known.status, { error: { code: known.code, message: known.message } })
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new HarnessAuthError(415, 'HARNESS_JSON_REQUIRED', '请使用 JSON 请求')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value: unknown = chunk
    if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new HarnessAuthError(400, 'HARNESS_JSON_INVALID', '请求内容无效')
    const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    size += bytes.length
    if (size > 65536) throw new HarnessAuthError(413, 'HARNESS_INPUT_TOO_LARGE', '请求内容过大')
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (_invalidJson) { throw new HarnessAuthError(400, 'HARNESS_JSON_INVALID', '请求内容无效') }
}
function cookieOf(request: IncomingMessage, name: string): string | undefined {
  const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`))
  const [entry] = values
  if (values.length !== 1 || entry === undefined) return undefined
  const value = entry.slice(name.length + 1)
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? value : undefined
}
function sameOrigin(request: IncomingMessage, config: HarnessConfig, upgrade = false): URL {
  const authorities = config.server.host === '::1' ? [`[::1]:${config.server.port}`, `localhost:${config.server.port}`] : [`127.0.0.1:${config.server.port}`, `localhost:${config.server.port}`]
  const authority = request.headers.host
  const origin = `http://${authority}`
  const target = request.url
  if (authority === undefined || !authorities.includes(authority) || target === undefined || !target.startsWith('/') || target.startsWith('//')
    || request.headers['sec-fetch-site'] === 'cross-site' || (upgrade && request.headers.origin === undefined)
    || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HarnessAuthError(403, 'HARNESS_ORIGIN_DENIED', '请求来源无效')
  if (!['GET', 'HEAD'].includes(request.method ?? '') && request.headers.origin !== origin) throw new HarnessAuthError(403, 'HARNESS_ORIGIN_DENIED', '请求来源无效')
  return new URL(target, origin)
}
function forwardHeaders(request: IncomingMessage, origin: string, secret: string): void {
  for (const key of Object.keys(request.headers)) {
    if (key === 'cookie' || key === 'authorization' || key === 'forwarded' || key.startsWith('x-forwarded-') || key.startsWith('x-harness-') || key.startsWith('sec-fetch-')) Reflect.deleteProperty(request.headers, key)
  }
  request.headers.host = new URL(origin).host
  request.headers.origin = origin
  request.headers[HARNESS_PRIVATE_HEADER] = secret
}
const mime: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml', woff2: 'font/woff2' }

/** 产品入口插件由 profile prepare 挂载，公开树不装配聊天或工具服务。 */
export const harnessEntry = {
  name: 'harness-public-entry',
  async apply(ctx: Context, options: { config: HarnessConfig; openBrowser: boolean }): Promise<void> {
    const { config } = options
    const cookieName = `harness_${config.environment}_${config.server.port}`
    const sockets = new Set<Duplex>()
    const coordinator = new HarnessCoordinator(config, () => { for (const socket of sockets) socket.destroy(); sockets.clear() })
    const proxy = httpProxy.createProxyServer({ ws: true, xfwd: false, changeOrigin: true })
    proxy.on('proxyRes', (response) => {
      delete response.headers['set-cookie']
      response.headers['cache-control'] = 'no-store'
      response.headers['x-content-type-options'] = 'nosniff'
    })
    const sourceAssets = new URL('../../web/harness-dist/', import.meta.url)
    const assets = existsSync(sourceAssets) ? sourceAssets : new URL('./resources/harness/', import.meta.url)
    const onRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const path = sameOrigin(request, config).pathname
      let cookie = cookieOf(request, cookieName)
      const allocateCookie = (): string => {
        if (cookie === undefined) {
          cookie = randomBytes(32).toString('base64url')
          response.setHeader('set-cookie', `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`)
        }
        return cookie
      }
      if (path.startsWith('/harness/assets/') && ['GET', 'HEAD'].includes(request.method ?? '')) {
        const file = path.slice('/harness/assets/'.length)
        if (!/^[\w.-]+\.(js|css|svg|woff2)$/u.test(file)) { reply(response, 404); return }
        const extension = file.split('.').at(-1)
        const contentType = extension === undefined ? undefined : mime[extension]
        if (contentType === undefined) { reply(response, 404); return }
        let bytes: Buffer
        try { bytes = await readFile(new URL(file, assets)) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; reply(response, 404); return }
        response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
        response.end(request.method === 'HEAD' ? undefined : bytes); return
      }
      if (path === '/harness/login' && request.method === 'GET') {
        allocateCookie()
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' })
        response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harness</title><link rel="stylesheet" href="/harness/assets/style.css"></head><body><div id="root"></div><script type="module" src="/harness/assets/auth.js"></script></body></html>'); return
      }
      if (path === '/harness/api/session' && request.method === 'GET') { const selected = allocateCookie(); reply(response, 200, await coordinator.status(selected)); return }
      if (path === '/harness/api/login' && request.method === 'POST') { reply(response, 200, { authenticated: true, ...await coordinator.login(await body(request), allocateCookie()) }); return }
      if (path === '/harness/api/logout' && request.method === 'POST') {
        const confirmed = await coordinator.logout(cookie)
        response.setHeader('set-cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
        reply(response, confirmed ? 200 : 503, { remote_confirmed: confirmed, ...confirmed ? {} : { error: { code: 'HARNESS_REMOTE_LOGOUT_UNCONFIRMED', message: '本机已退出，远端退出未确认' } } }); return
      }
      if (path === '/harness/api/renew' && request.method === 'POST') { reply(response, 200, { authenticated: true, ...(await coordinator.authorize(cookie, true)).session }); return }
      const captcha = /^\/harness\/api\/captcha\/(login|register)\/(challenges|verify)$/u.exec(path)
      if (captcha !== null && request.method === 'POST') {
        coordinator.assertOwner(cookie)
        await coordinator.auth.bootstrap()
        reply(response, 200, await coordinator.auth.request(`/auth/captcha/${captcha[1]}/${captcha[2]}`, 'POST', await body(request))); return
      }
      if (path === '/harness/api/register' && request.method === 'POST') {
        coordinator.assertOwner(cookie)
        await coordinator.auth.bootstrap()
        reply(response, 201, await coordinator.auth.request('/auth/register', 'POST', await body(request))); return
      }
      if (path.startsWith('/harness/')) { reply(response, 404); return }
      try {
        const access = await coordinator.authorize(cookie)
        forwardHeaders(request, access.origin, access.secret)
        sockets.add(request.socket)
        const release = (): void => { sockets.delete(request.socket) }
        response.once('close', release); response.once('finish', release)
        proxy.web(request, response, { target: access.origin }, (error: unknown) => { failure(response, error) })
      } catch (error) {
        if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
          response.writeHead(303, { location: '/harness/login', 'cache-control': 'no-store' }); response.end(); return
        }
        throw error
      }
    }
    const server = createServer((request, response) => {
      void onRequest(request, response).catch((error: unknown) => { failure(response, error) })
    })
    server.on('upgrade', (request, socket, head) => {
      void (async () => {
        sameOrigin(request, config, true)
        const access = await coordinator.authorize(cookieOf(request, cookieName))
        if (socket.destroyed) return
        forwardHeaders(request, access.origin, access.secret)
        sockets.add(socket); socket.once('close', () => { sockets.delete(socket) })
        proxy.ws(request, socket, head, { target: access.origin }, () => { socket.destroy() })
      })().catch(() => { socket.destroy() })
    })
    const onExit = (): void => { coordinator.terminateOnExit() }
    await ctx.effect(async () => {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.server.port, config.server.host, () => { server.off('error', reject); resolve() }) })
      const timer = setInterval(() => { void coordinator.heartbeat() }, config.auth.heartbeatIntervalMs)
      process.on('exit', onExit)
      return async () => {
        clearInterval(timer)
        await coordinator.stop()
        server.closeAllConnections()
        await new Promise<void>((resolve, reject) => server.close((error) => { if (error === undefined) resolve(); else reject(error) }))
        proxy.close()
        process.off('exit', onExit)
      }
    })
    const authority = config.server.host === '::1' ? `[::1]:${config.server.port}` : `${config.server.host}:${config.server.port}`
    const url = `http://${authority}/`
    process.stdout.write(`Harness: ${url}\n`)
    if (options.openBrowser) {
      const { default: open } = await import('open')
      await open(url)
    }
  },
}
