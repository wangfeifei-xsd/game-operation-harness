// @vitest-environment jsdom
/** 共享账号组件验证请求取消、重试及退出失败反馈，不连接中央服务。 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DownloadButton } from '../src/DownloadButton.tsx'
import { AccountControls } from '../src/AccountControls.tsx'
import { AuthPage } from '../src/AuthPage.tsx'
import { copy, LocalAuthError, type AuthOperation, type AuthTransport } from '../src/shared.ts'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const style = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => style(element))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

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

it('follows system appearance until a manual choice, retaining registration fields and remembering the choice', async () => {
  const media = new EventTarget()
  Object.assign(media, { matches: false })
  vi.stubGlobal('matchMedia', () => media)
  const transport: AuthTransport = { request<T>(operation: AuthOperation): Promise<T> {
    return Promise.resolve((operation === 'bootstrap'
      ? { registration_enabled: true, password_min_length: 12, password_max_length: 256 }
      : { authenticated: false }) as T)
  } }
  const view = render(<AuthPage transport={transport} onAuthenticated={vi.fn()} />)
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('false')
  act(() => { Object.assign(media, { matches: true }); media.dispatchEvent(new Event('change')) })
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('true')

  fireEvent.click(await screen.findByRole('tab', { name: copy.register }))
  fireEvent.change(screen.getByLabelText(copy.account), { target: { value: 'theme-user' } })
  fireEvent.change(screen.getByLabelText(copy.name), { target: { value: '主题用户' } })
  fireEvent.change(screen.getByLabelText(copy.password), { target: { value: 'theme-password-123' } })
  fireEvent.click(screen.getByRole('radio', { name: copy.light }))
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('false')
  expect(screen.getByLabelText(copy.account)).toHaveProperty('value', 'theme-user')
  expect(screen.getByLabelText(copy.name)).toHaveProperty('value', '主题用户')
  expect(screen.getByLabelText(copy.password)).toHaveProperty('value', 'theme-password-123')
  act(() => { media.dispatchEvent(new Event('change')) })
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('false')

  view.unmount()
  render(<AuthPage transport={transport} onAuthenticated={vi.fn()} />)
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('false')
  fireEvent.click(screen.getByRole('radio', { name: copy.dark }))
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('true')
  cleanup()
  render(<AuthPage transport={transport} onAuthenticated={vi.fn()} />)
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('true')
})

it('allows theme changes when local storage and authentication are unavailable', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage unavailable') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  const transport: AuthTransport = { request: () => Promise.reject(new LocalAuthError(503, '部署不可用')) }
  render(<AuthPage transport={transport} phase="starting" onAuthenticated={vi.fn()} />)
  await screen.findByText('部署不可用')
  fireEvent.click(screen.getByRole('radio', { name: copy.dark }))
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('true')
  fireEvent.click(screen.getByRole('radio', { name: copy.light }))
  expect(screen.getByRole('main').getAttribute('data-dark')).toBe('false')
  expect(screen.getByText('部署不可用')).toBeTruthy()
})

it('offers downloads only when the web entry supplies them', async () => {
  const transport: AuthTransport = { request<T>(operation: AuthOperation): Promise<T> {
    return Promise.resolve((operation === 'bootstrap'
      ? { registration_enabled: true, password_min_length: 12, password_max_length: 256 }
      : { authenticated: false }) as T)
  } }
  const view = render(<AuthPage transport={transport} onAuthenticated={vi.fn()} />)
  await screen.findByRole('tab', { name: copy.register })
  expect(screen.queryByRole('button', { name: copy.download })).toBeNull()
  view.rerender(<AuthPage transport={transport} onAuthenticated={vi.fn()} download={<DownloadButton transport={transport} />} />)
  expect(screen.getByRole('button', { name: copy.download })).toBeTruthy()
})

it('verifies the puzzle with the keyboard and retains the proof when changing appearance', async () => {
  const result = Promise.withResolvers<{ captcha_token: string; expires_in: number }>()
  const verify = vi.fn()
  const transport: AuthTransport = { request<T>(operation: AuthOperation, data?: object): Promise<T> {
    if (operation === 'bootstrap') return Promise.resolve({ registration_enabled: true, password_min_length: 12, password_max_length: 256 } as T)
    if (operation === 'captcha/login/challenges') return Promise.resolve({ challenge_id: 'keyboard-puzzle',
      background: 'data:image/png;base64,background', piece: 'data:image/png;base64,piece', piece_y: 20, piece_size: 40, width: 320, height: 160 } as T)
    if (operation === 'captcha/login/verify') { verify(data); return result.promise as Promise<T> }
    return Promise.resolve({ authenticated: false } as T)
  } }
  render(<ConfigProvider theme={{ token: { motion: false } }}><AuthPage transport={transport} onAuthenticated={vi.fn()} /></ConfigProvider>)
  await screen.findByRole('tab', { name: copy.register })
  await act(async () => { fireEvent.change(screen.getByLabelText(copy.account), { target: { value: 'keyboard-user' } }) })
  fireEvent.click(screen.getByRole('radio', { name: copy.dark }))
  fireEvent.click(screen.getByRole('button', { name: copy.verify }))
  const slider = await screen.findByRole('slider', { name: copy.position })
  await waitFor(() => { expect(slider.getAttribute('aria-disabled')).toBe('false') })
  fireEvent.keyDown(slider, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 })
  fireEvent.keyUp(slider, { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 })
  expect(verify).toHaveBeenCalledWith({ challenge_id: 'keyboard-puzzle', offset: 1 })
  expect(screen.getByRole('button', { name: copy.confirm })).toHaveProperty('disabled', true)
  await act(async () => { result.resolve({ captcha_token: 'keyboard-proof', expires_in: 120 }); await result.promise })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() }, { timeout: 2000 })
  expect(screen.getByRole('button', { name: copy.verified })).toBeTruthy()
  fireEvent.click(screen.getByRole('radio', { name: copy.light }))
  expect(screen.getByRole('button', { name: copy.verified })).toBeTruthy()
  expect(screen.getByLabelText(copy.account)).toHaveProperty('value', 'keyboard-user')
})

it('pairs from the public entry without signing in', async () => {
  const events: { operation: string; body: unknown }[] = []
  const authenticated = vi.fn()
  const transport: AuthTransport = {
    async request<T>(operation: AuthOperation, body?: object) {
      events.push({ operation, body })
      switch (operation) {
        case 'bootstrap': return { registration_enabled: true } as T
        case 'pairing/status': return { state: 'idle' } as T
        case 'pairing/lookup': return { id: 'selection', tenant: '俱乐部甲', account: '会员甲', entry: 'pc' } as T
        case 'pairing/claim': return { state: 'confirm' } as T
        default: throw new Error('请求超出公开配对流程')
      }
    },
  }
  render(<AuthPage transport={transport} onAuthenticated={authenticated} />)
  fireEvent.click(screen.getByRole('button', { name: copy.businessAssistant }))
  fireEvent.change(await screen.findByRole('textbox', { name: copy.businessCode }), { target: { value: 'A1B2C3D4' } })
  fireEvent.click(screen.getByRole('button', { name: copy.businessLookup }))
  fireEvent.change(await screen.findByRole('textbox', { name: copy.businessWorkspace }), { target: { value: '/workspace' } })
  fireEvent.click(await screen.findByRole('button', { name: copy.businessGrant }))
  await waitFor(() =>{  expect(events).toContainEqual({
    operation: 'pairing/claim', body: { id: 'selection', workspace: '/workspace', desktop: false, agents: false },
  }) })
  expect(events.some(row => row.operation === 'login')).toBe(false)
  expect(authenticated).not.toHaveBeenCalled()
})
