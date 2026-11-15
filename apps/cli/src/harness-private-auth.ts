/** 私有 Host 只信任父进程秘密，并在每个新的执行边界重新认证。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installHarnessAuthorization } from '@deepseek-ai/dsh-host-harness-product/authorization'
import { HarnessAuthError } from './harness-auth-client.ts'
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
  const authorize = installHarnessAuthorization(ctx, config, input, stop, () => process.connected)
  ctx.inject(['connection', 'connection.authentication'], (authCtx) => {
    const peer = authCtx.connection.createPeer({ principal: { kind: 'owner' } })
    authCtx.connection.authentication.register({ authenticate(request) {
      const value = request.headers instanceof Headers
        ? request.headers.get(HARNESS_PRIVATE_HEADER) ?? undefined : request.headers[HARNESS_PRIVATE_HEADER]
      return process.connected && typeof value === 'string' && sameHarnessSecret(value, input.secret) ? peer : undefined
    } })
  })
  ctx.on('webserver/request', async (request, response, next) => {
    const value = request.headers[HARNESS_PRIVATE_HEADER]
    if (typeof value !== 'string' || !sameHarnessSecret(value, input.secret)) { response.writeHead(401, { 'cache-control': 'no-store' }); response.end(); return }
    await next()
  }, { global: true, prepend: true })
  return authorize
}
