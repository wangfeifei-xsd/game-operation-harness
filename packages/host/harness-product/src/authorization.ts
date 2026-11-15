/** 两种本地载体共享中央执行授权；本机请求认证由载体独立拥有。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { HarnessAuthClient, HarnessAuthError } from './auth-client.ts'
import type { HarnessConfig } from './config.ts'

/** 私有 IPC 提供的中央会话事实。 */
export interface HarnessRuntimeIdentity {
  token: string
  user: { user_id: string }
  sessionId: string
}

/**
 * 在业务插件加载前安装中央检查，所有新的执行独立请求中央服务。
 * @param ctx - 产品根上下文。
 * @param config - 已校验部署文件。
 * @param identity - 本代启动身份。
 * @param stop - 同步封闭入口并安排有界停止。
 * @param connected - 本代父进程连接是否仍有效。
 * @param beforeCheck - 载体在系统休眠期间暂停执行的等待器。
 * @returns 启动、恢复和原生操作共用的检查函数。
 */
export function installHarnessAuthorization(ctx: Context, config: HarnessConfig, identity: HarnessRuntimeIdentity,
  stop: (error: HarnessAuthError) => void, connected: () => boolean, beforeCheck?: () => Promise<void>): () => Promise<void> {
  const client = new HarnessAuthClient(config)
  let live = true
  const deny = (error: unknown): void => {
    if (!live) return
    live = false
    stop(error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用'))
  }
  const isLive = (): boolean => live
  const authorize = async (): Promise<void> => {
    try {
      await beforeCheck?.()
      if (!isLive() || !connected()) throw new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '本地会话已结束')
      const session = await client.session(identity.token)
      if (!isLive() || !connected()) throw new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '本地会话已结束')
      if (session.user.user_id !== identity.user.user_id || session.session_id !== identity.sessionId) {
        throw new HarnessAuthError(401, 'HARNESS_IDENTITY_CHANGED', '认证服务身份不一致，请重新登录')
      }
    } catch (error) { deny(error); throw error }
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void authorize().catch(deny) }, config.auth.heartbeatIntervalMs)
    return () => { live = false; clearInterval(timer) }
  })
  ctx.on('webserver/request', async (_request, response, next) => {
    try { await authorize() }
    catch (error) { response.writeHead(error instanceof HarnessAuthError && error.status !== 503 ? 401 : 503, { 'cache-control': 'no-store' }); response.end(); return }
    response.setHeader('cache-control', 'no-store')
    await next()
  }, { global: true, prepend: true })
  ctx.on('webserver/upgrade', async (_request, _socket, _head, _peer, next) => { await authorize(); await next() }, { global: true, prepend: true })
  ctx.on('connection/authorize-operation', async (next) => { await authorize(); await next() }, { global: true, prepend: true })
  ctx.on('agent/created', async () => { await authorize() }, { global: true, prepend: true })
  ctx.on('agent/pre-step', async (_payload, next) => { await authorize(); return next() }, { global: true, prepend: true })
  ctx.on('tools/pre-execute', async (_execution, next) => { await authorize(); return next() }, { global: true, prepend: true })
  ctx.on('schedule/before-deliver', async (next) => { await authorize(); await next() }, { global: true, prepend: true })
  // 标题、压缩等独立模型调用也经过实际流入口，避免依赖主 Agent 检查。
  ctx.on('llm/stream', async function* (_options, next) { await authorize(); yield* next() }, { global: true, prepend: true })
  return authorize
}
