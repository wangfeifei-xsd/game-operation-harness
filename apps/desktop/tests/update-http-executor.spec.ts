import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientRequest } from 'electron'
import type { RequestOptions } from 'node:http'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import { DesktopUpdateHttpExecutor } from '../src/updates/electron-updater/http-executor.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function fixture() {
  const request = Object.assign(new EventEmitter(), { abort: vi.fn(() => { request.emit('abort') }) })
  const reject = vi.fn()
  new DesktopUpdateHttpExecutor(1000).addErrorAndTimeoutHandlers(request as unknown as ClientRequest, reject)
  return { request, reject }
}

describe('Electron updater inactivity deadline', () => {
  it('aborts a request that never receives headers without waiting for a Node socket event', async () => {
    const { request, reject } = fixture()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
    expect(request.abort).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refreshes the deadline on actual response bytes rather than timing out a long active download', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(900)
      response.emit('data', Buffer.from('data'))
    }
    expect(reject).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledOnce()
    expect(response.listenerCount('data')).toBe(0)
  })

  it.each(['abort', 'error'])('removes the deadline on request %s', async (event) => {
    const { request, reject } = fixture()
    request.emit(event, new Error('transport failure'))
    const count = reject.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(request.abort).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledTimes(count)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps waiting for headers after Electron closes the request writable stream', async () => {
    const { request, reject } = fixture()
    request.emit('finish')
    request.emit('close')
    await vi.advanceTimersByTimeAsync(1000)
    expect(reject).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'ETIMEDOUT' }))
  })

  it('does not leave a deadline running while completed bytes undergo verification', async () => {
    const { request, reject } = fixture()
    const response = new EventEmitter()
    request.emit('response', response)
    response.emit('end')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reject).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([0, 999, 1.5, NaN, 2_147_483_648])('rejects invalid inactivity configuration: %s', (value) => {
    expect(() => new DesktopUpdateHttpExecutor(value)).toThrow('idle timeout')
  })
})

const productUrl = 'https://updates.example.com/agent-assistant/test/stable/'
const trusted = { protocol: 'https:', hostname: 'updates.example.com', path: '/agent-assistant/test/stable/feeds/mac-arm64/stable-mac.yml' }

class ProductExecutor extends DesktopUpdateHttpExecutor {
  redirects(request: ClientRequest, reject: (error: Error) => void, handler: (options: RequestOptions) => void): void {
    this.addRedirectHandlers(request, trusted, reject, 0, handler)
  }
}

it.each([
  { hostname: 'other.example.com' }, { protocol: 'http:' }, { auth: 'user:password' },
  { path: '/agent-assistant/master/stable/feed.yml' }, { path: '/agent-assistant/test/stable/../feed.yml' },
  { path: '/agent-assistant/test/stable/bin/%2f..%2fprivate' }, { headers: { Host: 'other.example.com' } },
])('rejects an updater request outside its controlled source: %j', (override) => {
  const native = vi.spyOn(ElectronHttpExecutor.prototype, 'createRequest')
  const executor = new DesktopUpdateHttpExecutor(1000, undefined, productUrl)
  expect(() => executor.createRequest({ ...trusted, ...override }, () => {})).toThrow()
  expect(native).not.toHaveBeenCalled()
})

it.each([true, false])('accepts only a redirect within the product deployment: trusted=%s', (allowed) => {
  const abort = vi.fn()
  const request = Object.assign(new EventEmitter() as ClientRequest, { abort })
  const reject = vi.fn()
  const handler = vi.fn()
  const executor = new ProductExecutor(1000, undefined, productUrl)
  executor.redirects(request, reject, handler)
  request.emit('redirect', 302, 'GET', allowed ? `${productUrl}bin/mac-arm64/agent-assistant.zip` : 'https://other.example.com/agent-assistant.zip')
  expect(abort).toHaveBeenCalledOnce()
  expect(handler).toHaveBeenCalledTimes(allowed ? 1 : 0)
  expect(reject).toHaveBeenCalledTimes(allowed ? 0 : 1)
})

it('forces manual redirects before calling the native Electron transport', () => {
  const request = new EventEmitter() as ClientRequest
  const native = vi.spyOn(ElectronHttpExecutor.prototype, 'createRequest').mockReturnValue(request)
  const executor = new DesktopUpdateHttpExecutor(1000, undefined, productUrl)
  expect(executor.createRequest(trusted, () => {})).toBe(request)
  expect(native).toHaveBeenCalledWith(expect.objectContaining({ redirect: 'manual' }), expect.any(Function))
})
