// @vitest-environment jsdom
/** 共享账号组件验证请求取消、重试及退出失败反馈，不连接中央服务。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DownloadButton } from '../src/DownloadButton.tsx'
import { AccountControls } from '../src/AccountControls.tsx'
import { AuthPage } from '../src/AuthPage.tsx'
import { copy, LocalAuthError, type AuthOperation, type AuthTransport } from '../src/shared.ts'

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const style = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => style(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const index = { version: '1.0.0', files: [{ target: 'macos-arm64', filename: 'agent-assistant-1.0.0-mac-arm64.dmg',
  url: 'https://updates.example.com/installer.dmg', bytes: 1048576, sha256: 'a'.repeat(64) }] }

it('cancels a closed download request and ignores its late result after reopening', async () => {
  const first = Promise.withResolvers<typeof index | null>()
  const second = Promise.withResolvers<typeof index | null>()
  const signals: AbortSignal[] = []
  const transport: AuthTransport = { request<T>(_operation: AuthOperation, _data?: object, signal?: AbortSignal): Promise<T> {
    if (signal !== undefined) signals.push(signal)
    return (signals.length === 1 ? first.promise : second.promise) as Promise<T>
  } }
  render(<DownloadButton transport={transport} />)
  fireEvent.click(screen.getByRole('button', { name: copy.download }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  expect(signals[0]?.aborted).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: copy.download }))
  await act(async () => { second.resolve(null); await second.promise })
  expect(await screen.findByText(copy.unpublished)).toBeTruthy()
  await act(async () => { first.resolve(index); await first.promise })
  expect(screen.queryByRole('link', { name: copy.downloadFile })).toBeNull()
  cleanup()
  expect(signals[1]?.aborted).toBe(true)
})

it('retries unavailable download information before showing an actual installer link', async () => {
  let calls = 0
  const transport: AuthTransport = { request<T>(): Promise<T> {
    return ++calls === 1 ? Promise.reject(new Error('network failed')) : Promise.resolve(index as T)
  } }
  render(<DownloadButton transport={transport} />)
  fireEvent.click(screen.getByRole('button', { name: copy.download }))
  expect(await screen.findByText(copy.downloadFailed)).toBeTruthy()
  expect(screen.queryByRole('link', { name: copy.downloadFile })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.retry }))
  const link = await screen.findByRole('link', { name: copy.downloadFile })
  expect(link.getAttribute('href')).toBe(index.files[0]!.url)
  expect(screen.getByText('1.0.0')).toBeTruthy()
})

it('keeps sign-out failure visible in the narrow sidebar and hides desktop self-download', async () => {
  const logout = vi.fn(async () => { throw new LocalAuthError(503, '停止未完成，请重试') })
  const transport: AuthTransport = { request: () => Promise.reject(new Error('unexpected request')) }
  render(<AccountControls session={{ authenticated: true, user: { display_name: '账号' } }} wide={false} dark
    desktop transport={transport} logout={logout} />)
  expect(screen.queryByRole('button', { name: copy.download })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.logout }))
  fireEvent.click((await screen.findAllByRole('button', { name: copy.logout })).at(-1)!)
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '停止未完成，请重试')
  expect(logout).toHaveBeenCalledOnce()
})

it('reports deployment bootstrap failure without authenticating and cancels pending startup reads on unmount', async () => {
  const signals: AbortSignal[] = []
  const transport: AuthTransport = { request<T>(operation: AuthOperation, _data?: object, signal?: AbortSignal): Promise<T> {
    if (signal !== undefined) signals.push(signal)
    if (operation === 'bootstrap') return Promise.reject(new LocalAuthError(503, '部署不可用'))
    return Promise.resolve({ authenticated: false } as T)
  } }
  const authenticated = vi.fn()
  const view = render(<AuthPage transport={transport} onAuthenticated={authenticated} />)
  await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('部署不可用') })
  expect(authenticated).not.toHaveBeenCalled()
  view.unmount()
  expect(signals.every(signal => signal.aborted)).toBe(true)
})
