/** 私有入口和执行事件逐次认证，失败与晚回包均不能恢复访问。 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '../../../packages/client/connection/src/rpc-host.ts'
import { ConnectionAuthentication } from '../../../packages/client/connection/src/authentication.ts'
import { afterEach, beforeEach, expect, it, vi, type Mock, type MockInstance } from 'vitest'
import { HarnessAuthClient, HarnessAuthError, type HarnessSession } from '../src/harness-auth-client.ts'
import { readHarnessConfig } from '../src/harness-config.ts'
import { HARNESS_PRIVATE_HEADER, installHarnessPrivateAuth } from '../src/harness-private-auth.ts'

const connected = Object.getOwnPropertyDescriptor(process, 'connected')
const roots: Context[] = []
const servers: Server[] = []
const session: HarnessSession = {
  session_id: 'session_private', expires_in: 300, expires_at: '2027-01-01T00:00:00Z', absolute_expires_at: '2027-01-02T00:00:00Z',
  user: { user_id: 'user_private', login_name: 'private', display_name: '测试用户', status: 'ACTIVE' },
}

beforeEach(() => { Object.defineProperty(process, 'connected', { configurable: true, value: true }) })
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  }
  for (const ctx of roots.splice(0)) await ctx.fiber.dispose()
  if (connected) Object.defineProperty(process, 'connected', connected)
  else Reflect.deleteProperty(process, 'connected')
  vi.restoreAllMocks()
})

interface PrivateFixture {
  ctx: Context
  secret: string
  stop: Mock<() => void>
  central: MockInstance<HarnessAuthClient['session']>
}

async function setup(): Promise<PrivateFixture> {
  const ctx = new Context()
  roots.push(ctx)
  new ConnectionAuthentication(ctx)
  new HostConnectionService(ctx, [])
  const stop = vi.fn<() => void>()
  const secret = randomBytes(32).toString('base64url')
  const central = vi.spyOn(HarnessAuthClient.prototype, 'session').mockResolvedValue(session)
  const plugin = ctx.plugin({ apply(scope: Context) {
    installHarnessPrivateAuth(scope, readHarnessConfig('dev'), {
      kind: 'harness/start', generation: 1, sessionId: session.session_id, token: randomBytes(32).toString('base64url'), secret, user: session.user,
    }, stop)
  } })
  await plugin.await()
  return { ctx, secret, stop, central }
}

it('requires the parent secret for private HTTP and rejects legacy owner credentials', async () => {
  const { ctx, secret, central } = await setup()
  let downstream = 0
  const server = createServer((request, response) => {
    void ctx.waterfall('webserver/request', request, response, async () => {
      downstream += 1
      response.end('protected')
    }).catch(() => { response.destroy() })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试端口未分配')
  const url = `http://127.0.0.1:${address.port}/api/session/list`
  const denied = await fetch(url, { headers: { authorization: `Bearer ${secret}`, cookie: `dsh_token=${secret}` } })
  expect(denied.status).toBe(401)
  expect(central).not.toHaveBeenCalled()
  expect(downstream).toBe(0)
  const allowed = await fetch(url, { headers: { [HARNESS_PRIVATE_HEADER]: secret } })
  expect(await allowed.text()).toBe('protected')
  expect(allowed.headers.get('cache-control')).toBe('no-store')
  expect(downstream).toBe(1)
  expect(ctx.connection.authentication.authenticate({ headers: { [HARNESS_PRIVATE_HEADER]: secret } })).toHaveProperty('peer')
  expect(ctx.connection.authentication.authenticate({ headers: { authorization: `Bearer ${secret}` } })).toEqual({ rejection: 401 })
})

it('rechecks each new operation and schedule delivery and stays closed after a denial', async () => {
  const { ctx, central, stop } = await setup()
  const proceed = vi.fn(async () => {})
  await ctx.waterfall('connection/authorize-operation', proceed)
  await ctx.waterfall('schedule/before-deliver', proceed)
  expect(central).toHaveBeenCalledTimes(2)
  central.mockRejectedValueOnce(new HarnessAuthError(403, 'HARNESS_USER_DISABLED', '账号已停用'))
  await expect(ctx.waterfall('schedule/before-deliver', proceed)).rejects.toMatchObject({ code: 'HARNESS_USER_DISABLED' })
  await expect(ctx.waterfall('connection/authorize-operation', proceed)).rejects.toMatchObject({ code: 'HARNESS_RUNTIME_CLOSED' })
  expect(proceed).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledTimes(1)
  expect(stop).toHaveBeenCalledWith(expect.objectContaining({ status: 403, code: 'HARNESS_USER_DISABLED', message: '账号已停用' }))
})

it('rejects an earlier successful response after another execution boundary closes the runtime', async () => {
  const { ctx, central, stop } = await setup()
  let release: ((value: HarnessSession) => void) | undefined
  central.mockImplementationOnce(() => new Promise<HarnessSession>((resolve) => { release = resolve }))
  const proceed = vi.fn(async () => {})
  const pending = ctx.waterfall('connection/authorize-operation', proceed)
  const denied = expect(pending).rejects.toMatchObject({ code: 'HARNESS_RUNTIME_CLOSED' })
  central.mockRejectedValueOnce(new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用'))
  await expect(ctx.waterfall('schedule/before-deliver', proceed)).rejects.toMatchObject({ status: 503 })
  if (release === undefined) throw new Error('认证请求尚未发起')
  release(session)
  await denied
  expect(proceed).not.toHaveBeenCalled()
  expect(stop).toHaveBeenCalledTimes(1)
})
