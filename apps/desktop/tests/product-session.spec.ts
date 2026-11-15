/** 产品账号竞争、目录互斥、停用与停止失败的可复现行为。 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { readHarnessConfig } from '../../cli/src/harness-config.ts'
import { HarnessAuthError, type HarnessLogin, type HarnessSession } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import { acquireHarnessUserHome } from '@deepseek-ai/dsh-host-harness-product/home'
import { DesktopProductSession, type DesktopProductRuntime, type DesktopProductState } from '../src/product-session.ts'

const login: HarnessLogin = { token_type: 'Bearer', access_token: 'a'.repeat(43), session_id: 'session_a', expires_in: 300,
  expires_at: '2027-01-01T00:00:00Z', absolute_expires_at: '2027-01-02T00:00:00Z',
  user: { user_id: 'user_a', login_name: 'account_a', display_name: '账号甲', status: 'ACTIVE' } }

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-assistant-session-'))
  const config = { ...readHarnessConfig('test'), storage: { root: join(root, 'test') } }
  const runtime = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), observe: vi.fn(), suspend: vi.fn(),
    resume: vi.fn(async () => {}), terminateOnExit: vi.fn() } satisfies DesktopProductRuntime
  const states: DesktopProductState[] = []
  const create = vi.fn(() => runtime)
  const block = vi.fn()
  const retire = vi.fn(async () => {})
  const product = new DesktopProductSession({ config, createRuntime: create, block, retire, publish: (state) => { states.push(state) } })
  const authenticate = vi.spyOn(product.auth, 'login').mockResolvedValue(login)
  const central = vi.spyOn(product.auth, 'session').mockResolvedValue(login)
  const revoke = vi.spyOn(product.auth, 'request').mockResolvedValue(undefined)
  onTestFinished(async () => {
    vi.mocked(runtime.stop).mockResolvedValue()
    await product.stop()
    product.dispose(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks()
  })
  return { product, config, runtime, states, create, block, retire, authenticate, central, revoke }
}

it('does not allocate account resources before authentication and shares the Web home lock', async () => {
  const { product, config, create } = fixture()
  expect(product.state).toMatchObject({ state: 'signedOut', authenticated: false })
  expect(create).not.toHaveBeenCalled()
  await product.login({})
  expect(product.state).toMatchObject({ state: 'active', user: { display_name: '账号甲' } })
  expect(JSON.stringify(product.state)).not.toContain(login.access_token)
  await expect(acquireHarnessUserHome(config, login.user.user_id, () => {})).rejects.toMatchObject({ code: 'HARNESS_HOME_IN_USE' })
  await product.logout()
  const release = await acquireHarnessUserHome(config, login.user.user_id, () => {})
  await release()
})

it('revokes a token issued after cancellation without creating a Host', async () => {
  const { product, authenticate, revoke, create } = fixture()
  const issued = Promise.withResolvers<HarnessLogin>()
  authenticate.mockReturnValueOnce(issued.promise)
  const pending = product.login({})
  const rejected = expect(pending).rejects.toMatchObject({ code: 'HARNESS_LOGIN_CANCELLED' })
  await expect(product.login({})).rejects.toMatchObject({ code: 'HARNESS_INSTANCE_IN_USE' })
  await product.logout()
  issued.resolve(login)
  await rejected
  expect(create).not.toHaveBeenCalled()
  expect(revoke).toHaveBeenCalledWith('/auth/logout', 'POST', undefined, login.access_token)
  expect(product.state.state).toBe('signedOut')
})

it('blocks synchronously on denial and retains the lock until all teardown confirms completion', async () => {
  const { product, config, central, runtime, block } = fixture()
  await product.login({})
  const stopped = Promise.withResolvers<undefined>()
  vi.mocked(runtime.stop).mockReturnValueOnce(stopped.promise)
  central.mockRejectedValueOnce(new HarnessAuthError(403, 'HARNESS_USER_DISABLED', '账号已停用'))
  await expect(product.authorize()).rejects.toMatchObject({ code: 'HARNESS_USER_DISABLED' })
  expect(product.state).toMatchObject({ state: 'stopping', authenticated: false })
  expect(block).toHaveBeenCalledTimes(1)
  await expect(acquireHarnessUserHome(config, login.user.user_id, () => {})).rejects.toMatchObject({ code: 'HARNESS_HOME_IN_USE' })
  stopped.resolve(undefined)
  await expect.poll(() => product.state.state).toBe('unavailable')
  const release = await acquireHarnessUserHome(config, login.user.user_id, () => {})
  await release()
  await expect(product.authorize()).rejects.toMatchObject({ code: 'HARNESS_USER_DISABLED' })
})

it('retains the home after uncertain process teardown and retries before allowing another account', async () => {
  const { product, config, runtime } = fixture()
  await product.login({})
  vi.mocked(runtime.stop).mockRejectedValueOnce(new Error('process still present'))
  await expect(product.logout()).rejects.toThrow('process still present')
  expect(product.state.state).toBe('stopFailed')
  await expect(product.login({})).rejects.toMatchObject({ code: 'HARNESS_INSTANCE_IN_USE' })
  await expect(acquireHarnessUserHome(config, login.user.user_id, () => {})).rejects.toMatchObject({ code: 'HARNESS_HOME_IN_USE' })
  await product.logout()
  const release = await acquireHarnessUserHome(config, login.user.user_id, () => {})
  await release()
})

it('does not invalidate a new account when a previous account check finishes late', async () => {
  const { product, central, authenticate } = fixture()
  await product.login({})
  const old = Promise.withResolvers<HarnessSession>()
  central.mockReturnValueOnce(old.promise)
  const pending = product.authorize()
  const denied = expect(pending).rejects.toMatchObject({ code: 'HARNESS_LOGIN_CANCELLED' })
  await product.logout()
  const next = { ...login, session_id: 'session_b', user: { ...login.user, user_id: 'user_b', display_name: '账号乙' } }
  authenticate.mockResolvedValue(next); central.mockResolvedValue(next)
  await product.login({})
  old.resolve(login)
  await denied
  expect(product.state).toMatchObject({ state: 'active', user: { display_name: '账号乙' } })
})

it('separates local sign-out from an unconfirmed central revocation', async () => {
  const { product, revoke } = fixture()
  await product.login({})
  revoke.mockRejectedValueOnce(new Error('network unavailable'))
  expect(await product.logout()).toEqual({ remote_confirmed: false })
  expect(product.state).toMatchObject({ authenticated: false, error: { message: '本机已退出，远端退出未确认' } })
})

it('suspends execution and verifies both owners before resuming; background checks never renew', async () => {
  const { product, central, runtime } = fixture()
  await product.login({})
  product.suspend()
  expect(product.state).toMatchObject({ state: 'revalidating', authenticated: false })
  expect(runtime.suspend).toHaveBeenCalledOnce()
  await product.activity()
  expect(central).toHaveBeenCalledTimes(1)
  await product.resume()
  expect(runtime.resume).toHaveBeenCalledOnce()
  expect(product.state.state).toBe('active')
  expect(central.mock.calls.every(([, renew]) => renew !== true)).toBe(true)
  await product.activity(); await product.activity()
  expect(central.mock.calls.filter(([, renew]) => renew === true)).toHaveLength(1)
})
