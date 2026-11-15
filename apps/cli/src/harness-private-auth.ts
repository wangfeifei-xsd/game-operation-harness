/** 私有 Host 只信任父进程秘密，并在每个新的执行边界重新认证。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HarnessAuthClient, HarnessAuthError } from './harness-auth-client.ts'
import { sameHarnessSecret } from './harness-coordinator.ts'
import type { HarnessConfig } from './harness-config.ts'
import type { HarnessStart } from './harness-runtime-process.ts'

/** 父子进程之间的私有 HTTP 凭据头，入口转发前总会覆盖。 */
export const HARNESS_PRIVATE_HEADER = 'x-harness-parent-secret'

/**
 * 注册认证 provider、HTTP/WS 中间件和 Agent/工具/调度检查。
 * @param ctx - 产品根上下文，早于业务插件安装。
 * @param config - 文件部署配置。
 * @param input - 私有 IPC 身份。
 * @param stop - 认证失败时同步封闭并触发有界停止。
 * @returns 独立中央检查函数，供启动完成前复核使用。
 */
export function installHarnessPrivateAuth(
  ctx: Context, config: HarnessConfig, input: HarnessStart, stop: (error: HarnessAuthError) => void,
): () => Promise<void> {
  const client = new HarnessAuthClient(config)
  let live = true
  const assertLive = (): void => {
    if (!live || !process.connected) throw new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '本地会话已结束')
  }
  const deny = (error: unknown): void => {
    if (!live) return
    live = false
    stop(error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用'))
  }
  const authorize = async (): Promise<void> => {
    assertLive()
    try {
      const session = await client.session(input.token)
      assertLive()
      if (session.user.user_id !== input.user.user_id) throw new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '本地会话已结束')
    } catch (error) { deny(error); throw error }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void authorize().catch(deny) }, config.auth.heartbeatIntervalMs)
    return () => { live = false; clearInterval(timer) }
  })
  ctx.inject(['connection', 'connection.authentication'], (authCtx) => {
    const peer = authCtx.connection.createPeer({ principal: { kind: 'owner' } })
    authCtx.connection.authentication.register({ authenticate(request) {
      const value = request.headers instanceof Headers
        ? request.headers.get(HARNESS_PRIVATE_HEADER) ?? undefined : request.headers[HARNESS_PRIVATE_HEADER]
      return live && typeof value === 'string' && sameHarnessSecret(value, input.secret) ? peer : undefined
    } })
  })
  ctx.on('webserver/request', async (request, response, next) => {
    const value = request.headers[HARNESS_PRIVATE_HEADER]
    if (typeof value !== 'string' || !sameHarnessSecret(value, input.secret)) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
    try { await authorize() }
    catch (error) {
      response.writeHead(error instanceof HarnessAuthError && error.status !== 503 ? 401 : 503, { 'cache-control': 'no-store' }); response.end(); return
    }
    response.setHeader('cache-control', 'no-store')
    await next()
  }, { global: true, prepend: true })
  ctx.on('webserver/upgrade', async (_request, _socket, _head, _peer, next) => { await authorize(); await next() }, { global: true, prepend: true })
  ctx.on('connection/authorize-operation', async (next) => { await authorize(); await next() }, { global: true, prepend: true })
  ctx.on('agent/pre-step', async (_payload, next) => { await authorize(); return next() }, { global: true, prepend: true })
  ctx.on('tools/pre-execute', async (_execution, next) => { await authorize(); return next() }, { global: true, prepend: true })
  ctx.on('schedule/before-deliver', async (next) => { await authorize(); await next() }, { global: true, prepend: true })
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'html', placement: 'head', html: '<link rel="stylesheet" href="/harness/assets/style.css">' })
    table.push({ kind: 'html', placement: 'head', html: '<script type="module" src="/harness/assets/panel.js"></script>' })
  }, { global: true })
  return authorize
}
