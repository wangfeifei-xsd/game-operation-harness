import { parsePluginOperationRecord } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import type { DesktopHostProcess } from '../src/host-process.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron'
import { DESKTOP_IPC, type DesktopUpdateState } from '../src/ipc.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { en, zh } from '../src/locale.ts'
import { writeCrashReport } from '../src/crash-report.ts'
import { runOperationReportJob } from '../src/operation-report-job.ts'
import { PRODUCT_IPC } from '../src/product-protocol.ts'
import { readHarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'
import { fileURLToPath } from 'node:url'

vi.mock('../src/product-config.ts', () => ({
  readDesktopProductConfiguration() {
    const directory = fileURLToPath(new URL('../../../config/environments/', import.meta.url))
    const config = readHarnessConfig('test', directory)
    if (harness.embeddedPolicy && typeof harness.embeddedPolicy === 'object' && 'origin' in harness.embeddedPolicy) config.desktop.mandatoryUpdate = { enabled: true, url: String(harness.embeddedPolicy.origin) }
    config.storage.root = join(harness.app.getPath('userData'), 'product')
    config.desktop.updates = { enabled: true, url: 'https://updates.example.com/agent-assistant/test/stable/' }
    return { config, directory, mode: 'local' }
  },
}))
vi.mock('@deepseek-ai/dsh-host-harness-product/auth-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-host-harness-product/auth-client')>()
  const session = { session_id: 'session-a', expires_in: 3600, expires_at: '2027-01-01T00:00:00Z', absolute_expires_at: '2027-01-01T00:00:00Z',
    user: { user_id: 'user-a', login_name: 'account-a', display_name: '用户 A', status: 'ACTIVE' as const } }
  return { ...actual, HarnessAuthClient: class extends actual.HarnessAuthClient {
    override async login() { return { ...session, access_token: 'private-test-token', token_type: 'Bearer' as const } }
    override async session() { return session }
    override async request() { return undefined }
  } }
})

type InvokeEvent = { sender?: unknown; senderFrame: { url: string } }
type InvokeHandler = (event: InvokeEvent, ...args: unknown[]) => unknown

const fileDrag = vi.hoisted(() => ({ dispose: vi.fn<() => Promise<void>>(), install: vi.fn() }))
vi.mock('../src/file-drag.ts', () => ({ installDesktopFileDrag: () => { fileDrag.install(); return fileDrag.dispose } }))

vi.mock('../src/web-document.ts', () => ({
  serveWebDocument: vi.fn(), forwardWebRequest: vi.fn(),
  removeLegacyHostCookies: harness.removeLegacyHostCookies,
}))
vi.mock('../src/operation-report-job.ts', () => ({ runOperationReportJob: vi.fn(async () => ({ appended: false, timedOut: false, cancelled: false })) }))
// Report persistence has its own unit tests; here it resolves within microtasks so the fatal
// dialog never outlives the test that triggered it.
vi.mock('../src/crash-report.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/crash-report.ts')>(),
  writeCrashReport: vi.fn<(...args: unknown[]) => Promise<string | undefined>>(),
  pruneCrashReports: vi.fn(async () => {}),
}))

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  const authWindows: FakeWindow[] = []
  let windowFailure: Error | undefined
  const powerMonitor = new EventEmitter()
  const hosts: FakeHost[] = []
  const handlers = new Map<string, InvokeHandler>()
  let pluginsEnabled = false
  let prepareUpdate: (() => Promise<boolean>) | undefined
  let publishUpdate: ((state: DesktopUpdateState) => DesktopUpdateState) | undefined
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  let policyBlocked = deferred()
  let authReady = deferred()
  let embeddedPolicy: unknown
  let closeWindowsOnQuit = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const readLoginShell = async (base: NodeJS.ProcessEnv) => ({
    environment: { ...base, DSH_TEST_LOGIN_SHELL: 'login' }, failures: [{ shell: '/account/shell', reason: 'timeout' }],
  })
  const loginShell = vi.fn((base: NodeJS.ProcessEnv, _config: unknown, _options: { signal?: AbortSignal }) => readLoginShell(base))
  const updateCheck = vi.fn(async (_manual?: boolean): Promise<DesktopUpdateState> => updateState)
  const updateDownload = vi.fn(async (_version: string, _revision?: number): Promise<DesktopUpdateState> => updateState)
  const updateInstall = vi.fn(async (_version: string, _revision?: number): Promise<DesktopUpdateState> => updateState)
  const popup = vi.fn<(options: { window: FakeWindow; x?: number; y?: number; callback?: () => void }) => void>()
  const menuBuilder = vi.fn<(template: MenuItemConstructorOptions[]) => { popup: typeof popup }>(() => ({ popup }))
  const menu = Object.assign(menuBuilder, { buildFromTemplate: menuBuilder, setApplicationMenu: vi.fn() })
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      mainFrame: { url: '' },
      getZoomFactor: () => 1,
      isDestroyed: () => this.destroyed,
      setIgnoreMenuShortcuts: vi.fn(),
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      send: vi.fn((channel: string, state: { policy?: { blocking: boolean } }) => {
        if (channel === 'dsh-desktop:mandatory-state' && state.policy?.blocking) policyBlocked.resolve()
      }),
    })
    readonly shown = deferred()
    readonly show = vi.fn(() => { this.shown.resolve() })
    readonly hide = vi.fn()
    readonly focus = vi.fn()
    readonly moveTop = vi.fn()
    readonly setAlwaysOnTop = vi.fn()
    readonly restore = vi.fn()
    readonly setSize = vi.fn()
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 800, height: 700 }))
    readonly setMinimumSize = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
    readonly setVibrancy = vi.fn()
    readonly setBackgroundColor = vi.fn()
    constructor(readonly options: { show: boolean; modal?: boolean }) {
      super(); if (windowFailure !== undefined) throw windowFailure; windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    fullscreen = false
    isFullScreen() { return this.fullscreen }
    readonly setFullScreen = vi.fn((flag: boolean) => { this.fullscreen = flag; this.emit(flag ? 'enter-full-screen' : 'leave-full-screen') })
    minimized = false
    isMinimized() { return this.minimized }
    visible = true
    isVisible() { return this.visible }
    isFocused() { return true }
    async loadURL(url: string) {
      if (url === 'dsh-app://auth/' && !authWindows.includes(this)) {
        windows.splice(windows.indexOf(this), 1); authWindows.push(this)
      }
      this.urls.push(url)
      this.webContents.mainFrame.url = url
      if (url === 'dsh-app://app/') navigated.resolve()
    }
    static getAllWindows() { return [...windows, ...authWindows].filter(window => !window.destroyed) }
    setMenu() {}
    getContentBounds() { return { x: 0, y: 0, width: 900, height: 650 } }
    setBounds() {}
    setTitle = vi.fn()
    destroy() { this.destroyed = true; this.emit('closed') }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length === 0) this.destroy()
    }
  }
  const views: FakeView[] = []
  class FakeView extends FakeWindow {
    constructor() {
      super({ show: false })
      windows.pop()
      views.push(this)
      Object.assign(this.webContents, {
        loadURL: (url: string) => this.loadURL(url),
        close: () => { this.destroy(); this.webContents.emit('destroyed') },
      })
    }
  }
  class FakeHost {
    readonly observe = vi.fn()
    readonly suspend = vi.fn()
    readonly resume = vi.fn(async () => {})
    readonly terminateOnExit = vi.fn()
    readonly updateTasks = vi.fn(async (_action: 'inspect' | 'lock' | 'unlock') => false)
    readonly inspectQuit = vi.fn(async () => ({ activeTasks: false, scheduledTasks: false }))
    url = 'http://127.0.0.1:3080/'
    fetch = vi.fn(async () => Response.json({ localePreference: null, themePreference: 'system' }))
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise.then(() => ({ url: this.url, injections: [], authenticationCookie: 'dsh-desktop-session=test-private' })) })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv, readonly onFailure?: (error: Error) => void,
      readonly primaryRuntime?: string,
      readonly packageManager?: { pnpm: string; nodeBin: string },
      readonly onPluginOperation?: ConstructorParameters<typeof DesktopHostProcess>[8],
    ) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: (): string => 'en-US',
    getPreferredSystemLanguages: () => ['en-US'],
    getVersion: () => '1.0.0',
    getAppPath: (): string => 'desktop-test-app',
    setName: vi.fn(), setPath: vi.fn(), setAppUserModelId: vi.fn(), clearRecentDocuments: vi.fn(),
    setAppLogsPath: vi.fn(),
    getPath: vi.fn<(name: string) => string>(),
    setAboutPanelOptions: vi.fn<(options: Electron.AboutPanelOptionsOptions) => void>(),
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: vi.fn(),
    exit: vi.fn(),
    relaunch: vi.fn(),
    focus: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) {
        if (closeWindowsOnQuit) for (const window of [...windows]) if (!window.isDestroyed()) window.close()
        if (!closeWindowsOnQuit || windows.every(window => window.isDestroyed())) quitCompleted.resolve()
      }
    }),
  })
  let analyticsEnabled = true
  const analytics = vi.fn(async (_event: unknown) => {})
  const nativeTheme = new class extends EventEmitter {
    themeSource = 'system'
    systemDark = false
    get shouldUseDarkColors() { return this.themeSource === 'system' ? this.systemDark : this.themeSource === 'dark' }
    set shouldUseDarkColors(value: boolean) { this.systemDark = value }
  }()
  const trays: FakeTray[] = []
  class FakeTray extends EventEmitter {
    readonly setToolTip = vi.fn()
    readonly setContextMenu = vi.fn()
    readonly destroy = vi.fn()
    constructor(readonly image: unknown) { super(); trays.push(this) }
  }
  const backgroundNotice = { close: vi.fn((hide: () => void) => { hide() }), dispose: vi.fn(), markerPath: undefined as string | undefined }
  const shellDialog = { isOpen: false, focus: vi.fn() }
  return {
    failWindow(error: Error) { windowFailure = error },
    windows, authWindows, views, hosts, handlers, app, FakeWindow, FakeView, FakeHost, powerMonitor, nativeTheme, analytics,
    get authReady() { return authReady },
    trays, FakeTray, backgroundNotice, shellDialog,
    menu, popup, socketHeaders: vi.fn(), connectWelcome: vi.fn(), removeLegacyHostCookies: vi.fn(async () => {}), hostCookies: {},
    loginShell, readLoginShell, updateCheck, updateDownload, updateInstall,

    get analyticsEnabled() { return analyticsEnabled },
    set analyticsEnabled(value: boolean) { analyticsEnabled = value },
    ipcOn: vi.fn<(channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => void) => void>(),
    get updateState() { return updateState },
    set updateState(value: DesktopUpdateState) { updateState = value },
    get prepareUpdate() { return prepareUpdate! },
    set prepareUpdate(value: () => Promise<boolean>) { prepareUpdate = value },
    get publishUpdate() { return publishUpdate! },
    set publishUpdate(value: (state: DesktopUpdateState) => DesktopUpdateState) { publishUpdate = value },
    dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    openExternal: vi.fn(async () => {}),
    showItemInFolder: vi.fn(),
    protocolHandle: vi.fn<(scheme: string, handler: (request: Request) => Response | Promise<Response>) => void>(),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    disableAllPlugins: vi.fn(async () => {
      pluginsEnabled = false
      return 'desktop-test-profile/cordis.patch.yml.bak-1789555200000'
    }),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get dialogShown() { return dialogShown }, get quitCompleted() { return quitCompleted },
    get policyBlocked() { return policyBlocked },
    get embeddedPolicy() { return embeddedPolicy },
    set embeddedPolicy(value: unknown) { embeddedPolicy = value },
    nextNavigation() { navigated = deferred(); return navigated.promise },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    set closeWindowsOnQuit(value: boolean) { closeWindowsOnQuit = value },
    reset() {
      windows.length = 0
      authWindows.length = 0
      views.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      trays.length = 0
      backgroundNotice.markerPath = undefined
      shellDialog.isOpen = false
      powerMonitor.removeAllListeners()
      app.isPackaged = true
      windowFailure = undefined
      pluginsEnabled = false
      closeWindowsOnQuit = false
      prepareUpdate = undefined
      publishUpdate = undefined
      updateState = { phase: 'idle' }
      updateCheck.mockReset().mockImplementation(async () => updateState)
      loginShell.mockReset().mockImplementation(base => readLoginShell(base))
      updateDownload.mockReset().mockImplementation(async () => updateState)
      updateInstall.mockReset().mockImplementation(async () => updateState)
      nativeTheme.removeAllListeners()
      nativeTheme.themeSource = 'system'; nativeTheme.shouldUseDarkColors = false
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); dialogShown = deferred(); quitCompleted = deferred()
      policyBlocked = deferred()
      authReady = deferred()
      embeddedPolicy = undefined
      fileDrag.install.mockReset()
      fileDrag.dispose.mockReset().mockResolvedValue(undefined)
    },
  }
})

const testAuth = vi.hoisted(() => ({ login: vi.fn<() => Promise<'returned' | 'cancelled' | 'failed'>>(),
  focus: vi.fn(), dispose: vi.fn(async () => {}) }))
vi.mock('../src/policy-test-auth.ts', () => ({ DesktopPolicyTestAuth: class {
  readonly login = testAuth.login
  readonly focus = testAuth.focus
  readonly dispose = testAuth.dispose
  readonly request: typeof fetch = (input, init) => fetch(input, init)
} }))

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  WebContentsView: harness.FakeView,
  dialog: harness.dialog,
  shell: { openExternal: harness.openExternal, showItemInFolder: harness.showItemInFolder },
  nativeTheme: harness.nativeTheme,
  ipcMain: {
    on: harness.ipcOn,
    handle: (channel: string, handler: InvokeHandler) => {
      if (harness.handlers.has(channel)) throw new Error(`duplicate IPC handler ${channel}`)
      harness.handlers.set(channel, handler)
      if (channel === PRODUCT_IPC.request) harness.authReady.resolve()
    },
    removeHandler: (channel: string) => { harness.handlers.delete(channel) },
  },
  Menu: { setApplicationMenu: harness.menu.setApplicationMenu, buildFromTemplate: harness.menu },
  session: { fromPartition: () => ({
    on: vi.fn(), cookies: harness.hostCookies, protocol: { handle: harness.protocolHandle, unhandle: vi.fn() },
    closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: harness.socketHeaders },
  }), defaultSession: {
    protocol: { handle: harness.protocolHandle, unhandle: vi.fn() },
    on: vi.fn(), cookies: harness.hostCookies,
    setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), webRequest: { onBeforeSendHeaders: harness.socketHeaders },
  } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: harness.protocolHandle },
  powerMonitor: harness.powerMonitor,
  Tray: harness.FakeTray,
  nativeImage: { createFromPath: (path: string) => ({ path }) },
}))
vi.mock('../src/background-notice.ts', () => ({ DesktopBackgroundNotice: class {
  constructor(options: { markerPath: string }) { harness.backgroundNotice.markerPath = options.markerPath }
  readonly close = harness.backgroundNotice.close
  readonly dispose = harness.backgroundNotice.dispose
} }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn((path: Parameters<typeof original.readFile>[0], encoding?: 'utf8') => {
    if (path === join('desktop-test-app', 'package.json')) {
      return Promise.resolve(JSON.stringify({ dshDesktopAppId: 'com.deepseek.dsh', dshMandatoryUpdatePolicy: harness.embeddedPolicy }))
    }
    return encoding === undefined ? original.readFile(path) : original.readFile(path, encoding)
  }) }
})
vi.mock('../src/login-shell-environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/login-shell-environment.ts')>(),
  readDesktopLoginShellEnvironment: harness.loginShell,
}))
vi.mock('../src/runtime-tree.ts', () => ({ readDesktopRuntime: () => ({ release: { version: '1.0.0' } }) }))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    disableAllPlugins = harness.disableAllPlugins

  },
}))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(), DesktopHostProcess: harness.FakeHost,
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  get isOpen() { return harness.shellDialog.isOpen }
  input() { return { revision: 0, blocked: false } }
  show(owner: { options: { modal?: boolean } }, options: unknown) {
    return (owner.options.modal ? harness.dialog.showMessageBox(owner, options)
      : harness.dialog.showMessageBox(options)) as Promise<Electron.MessageBoxReturnValue>
  }
  cancel() {}
  readonly focus = harness.shellDialog.focus
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  selectedChannel: 'nightly' | 'stable' = 'nightly'
  revision = 0
  configurationFailure: 'startup' | 'cleanup' | undefined
  constructor(publish: (state: DesktopUpdateState) => DesktopUpdateState, beforeRestart: () => Promise<boolean>,
    _updater: unknown, _enabled: unknown, _version: unknown, _downloadResult: unknown, channel: 'nightly' | 'stable') {
    this.selectedChannel = channel
    harness.prepareUpdate = beforeRestart
    harness.publishUpdate = publish
  }
  async switchChannel(channel: 'nightly' | 'stable', persist: () => Promise<void>) {
    await persist()
    this.selectedChannel = channel
    this.configurationFailure = undefined
    this.revision++
    harness.updateState = { phase: 'idle' }
    return 'applied' as const
  }
  suspendConfiguration(detail: string, reason: 'startup' | 'cleanup' = 'startup') {
    this.configurationFailure = reason
    harness.updateState = { phase: 'error', failedOperation: 'configuration', message: detail }
    harness.publishUpdate(harness.updateState)
  }
  get state() { return harness.updateState }
  readonly check = harness.updateCheck
  readonly download = harness.updateDownload
  readonly install = harness.updateInstall
  readonly dispose = vi.fn()
} }))
vi.mock('../src/startup-backend.ts', () => ({
  connectDesktopStartup: (...args: unknown[]) => {
    harness.connectWelcome(...args)
    return {
      analyticsEnabled: async () => harness.analyticsEnabled,
      report: harness.analytics,
      readLocalePreference: async () => null,
      read: async (): Promise<unknown> => (await harness.hosts.at(-1)!.fetch()).json() as Promise<unknown>,
    }
  },
}))

let loginOperation: Promise<unknown> | undefined

/** 原生能力回归显式经过产品登录；未登录行为使用单独用例。 */
async function startAuthenticated(): Promise<void> {
  await import('../src/main.ts')
  await harness.authReady.promise
  const window = harness.authWindows[0]!
  const handler = harness.handlers.get(PRODUCT_IPC.request)!
  loginOperation = Promise.resolve(handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'login', {
    login_name: 'account-a', password: 'safe-test-password', captcha_token: 'test-proof',
  }))
}

function configureTestAuthPopup(allow: boolean): void {
  const directory = join(harness.app.getPath('userData'), 'desktop')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({ updates: { allowTestAuthPopupWindow: allow } }))
}

function invoke(channel: string, origin = channel === DESKTOP_IPC.boot ? 'app' : 'shell', ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  if (origin === 'app') {
    const sender = harness.windows[0]!.webContents
    return handler({ sender, senderFrame: sender.mainFrame }, ...args)
  }
  return handler({ senderFrame: { url: `dsh-app://${origin}/index.html` } }, ...args)
}

function applicationMenuItems(): MenuItemConstructorOptions[] {
  const native = harness.menu.mock.calls[0]?.[0][0]?.submenu
  if (Array.isArray(native)) return native
  const sender = harness.windows[0]!.webContents
  void harness.handlers.get(DESKTOP_IPC.windowsMenu)!({ sender, senderFrame: sender.mainFrame }, 'application', 0, 0)
  return harness.menu.mock.lastCall![0]
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  harness.dialog.showMessageBox.mockReset()
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  testAuth.login.mockReset()
  testAuth.login.mockResolvedValue('cancelled')
  vi.useFakeTimers()
  harness.reset()
  loginOperation = undefined
  const userData = mkdtempSync(join(tmpdir(), 'dsh-main-user-data-'))
  onTestFinished(() => { rmSync(userData, { recursive: true, force: true }) })
  harness.app.getPath.mockImplementation(name => name === 'userData' ? userData : join(userData, `desktop-test-${name}`))
  vi.mocked(writeCrashReport).mockResolvedValue(join(harness.app.getPath('logs'), 'crash-test.log'))
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title !== en.startupFailed && options.title !== zh.startupFailed) return Promise.resolve({ response: 1 })
    harness.dialogShown.resolve()
    return new Promise(() => {})
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubEnv('DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'test-primary-runtime')
  vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'win32', arch: 'x64', resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_DEV_PROJECT_DIR', undefined)
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
  vi.stubEnv('DSH_CLIENT_VERSION', '1.2.3')
  harness.analyticsEnabled = true
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  // The quit decides asynchronously; a Host that starts meanwhile must still be released.
  await vi.advanceTimersByTimeAsync(0)
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  await harness.quitCompleted.promise
  await loginOperation
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('keeps a cold launch on the local product login page without reading an account home or starting a Host', async () => {
    await import('../src/main.ts')
    await harness.authReady.promise
    expect(harness.hosts).toHaveLength(0)
    expect(harness.windows).toHaveLength(0)
    expect(harness.applyRelease).not.toHaveBeenCalled()
    const window = harness.authWindows[0]!
    expect(window.urls).toEqual(['dsh-app://auth/'])
    const request = harness.handlers.get(PRODUCT_IPC.request)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    expect(await request(event, 'session')).toMatchObject({ ok: true, value: { authenticated: false, state: 'signedOut' } })
    for (const foreign of [{ ...event, sender: {} }, { ...event, senderFrame: { url: 'dsh-app://auth/' } }]) {
      expect(await request(foreign, 'login', {})).toMatchObject({ ok: false, error: { code: 'HARNESS_ORIGIN_DENIED' } })
    }
    expect(harness.hosts).toHaveLength(0)
  })

  it('keeps stable controlled by deployment and rejects an unpublished channel even with legacy local preferences', async () => {
    configureTestAuthPopup(true)
    const file = join(harness.app.getPath('userData'), 'desktop', 'settings.json')
    writeFileSync(file, '{"updates":{"channel":"nightly"}}')
    await readyForUpdate()
    expect(await invoke(DESKTOP_IPC.updatesChannelGet, 'app')).toMatchObject({ channel: 'stable', packagedChannel: 'stable' })
    await expect(invoke(DESKTOP_IPC.updatesChannelSet, 'app', 'nightly')).rejects.toThrow('尚未开放')
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('revokes the old window before logout finishes and never exposes product secrets to the renderer', async () => {
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    const request = harness.handlers.get(PRODUCT_IPC.request)!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const state = await request(event, 'session')
    expect(JSON.stringify(state)).not.toContain('private-test-token')
    expect(state).toMatchObject({ ok: true, value: { authenticated: true, user: { login_name: 'account-a' } } })
    expect(await request(event, 'login', {})).toMatchObject({ ok: false, error: { code: 'HARNESS_ORIGIN_DENIED' } })
    const logout = request(event, 'logout')
    expect(window.destroyed).toBe(true)
    expect(await request(event, 'session')).toMatchObject({ ok: false })
    await host.stopping.promise
    host.exited.resolve()
    await logout
    expect(harness.hosts).toHaveLength(1)
    expect(harness.authWindows[0]!.show).toHaveBeenCalled()
  })

  it('stops the account runtime when workspace preferences cannot load and allows a fresh login', async () => {
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.fetch.mockRejectedValue(new Error('preferences unavailable'))
    host.ready.resolve()
    await host.stopping.promise
    host.exited.resolve()
    expect(await loginOperation).toMatchObject({ ok: false, error: { code: 'HARNESS_START_FAILED' } })
    expect(harness.windows).toHaveLength(0)
    const auth = harness.authWindows[0]!
    expect(await harness.handlers.get(PRODUCT_IPC.request)!({ sender: auth.webContents, senderFrame: auth.webContents.mainFrame }, 'session'))
      .toMatchObject({ ok: true, value: { authenticated: false, state: 'unavailable' } })
  })

  it.each([true, false])('selects the package manager before Host startup (packaged=%s)', async (packaged) => {
    harness.app.isPackaged = packaged
    await readyForUpdate()
    const host = harness.hosts[0]!
    expect(host.node).toBe(process.execPath)
    expect(host.primaryRuntime).toBe(packaged
      ? join('desktop-test-resources', 'runtime', 'primary-runtime') : 'test-primary-runtime')
    expect(host.packageManager).toMatchObject({
      pnpm: packaged
        ? join('desktop-test-resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
        : 'test-pnpm',
      nodeBin: packaged ? join('desktop-test-resources', 'runtime', 'bin') : join('desktop-test-app', 'scripts', 'node-bin'),
    })
  })

  it('starts the Host without resolving Kit or writing a diagnostic file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-main-office-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    writeFileSync(join(root, 'app.asar'), 'archive fixture')
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', join(root, 'app.asar', 'dsh'))
    const host = await readyForUpdate()
    expect(harness.analytics).not.toHaveBeenCalled()
    expect(host.primaryRuntime).toBe('test-primary-runtime')
    expect(existsSync(harness.app.getPath('logs'))).toBe(false)
    expect(writeCrashReport).not.toHaveBeenCalled()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.startupFailed }))
  })

  it('starts the Host with authentication popups disabled when local settings are invalid', async () => {
    configureTestAuthPopup(false)
    const path = join(harness.app.getPath('userData'), 'desktop', 'settings.json')
    const raw = '{"updates":{"allowTestAuthPopupWindow":"true"}}'
    writeFileSync(path, raw)
    await readyForUpdate()
    expect(harness.hosts).toHaveLength(1)
    expect(testAuth.login).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(path), expect.any(Error))
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalledWith(expect.objectContaining({ title: en.startupFailed }))
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })

  it('routes shell update documents and assets through the registered main protocol handler', async () => {
    const root = join(import.meta.dirname, '..')
    vi.spyOn(harness.app, 'getAppPath').mockReturnValue(root)
    const web = await import('../src/web-document.ts')
    const actual = await vi.importActual<typeof import('../src/web-document.ts')>('../src/web-document.ts')
    vi.mocked(web.serveWebDocument).mockImplementation(actual.serveWebDocument)
    try {
      await readyForUpdate()
      const { protocol } = await import('electron')
      const handler = vi.mocked(protocol).handle.mock.calls.at(-1)?.[1]
      if (handler === undefined) throw new Error('main did not register its protocol handler')
      for (const [name, mime] of [
        ['update-dialog.html', 'text/html'], ['update-dialog.css', 'text/css'], ['update-dialog.js', 'text/javascript'],
        ['mandatory-update.html', 'text/html'], ['mandatory-update.css', 'text/css'], ['mandatory-update.js', 'text/javascript'],
        ['update-close.svg', 'image/svg+xml'], ['shell-theme.js', 'text/javascript'],
      ] as const) {
        const response = await handler(new Request(`dsh-app://shell/${name}`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain(mime)
        expect(await response.text()).toBe(readFileSync(join(root, 'renderer', name), 'utf8'))
      }
      const head = await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'HEAD' }))
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await handler(new Request('dsh-app://shell/update-dialog.html', { method: 'POST' }))).status).toBe(405)
      expect((await handler(new Request('dsh-app://shell/%'))).status).toBe(400)
      expect((await handler(new Request('dsh-app://shell/%2e%2e%2fpackage.json'))).status).toBe(403)
      expect((await handler(new Request('dsh-app://shell/missing.html'))).status).toBe(404)
      expect((await handler(new Request('dsh-app://other/update-dialog.html'))).status).toBe(404)
    } finally {
      vi.mocked(web.serveWebDocument).mockReset()
    }
  })

  it('serves shell dialogs and their assets without forwarding them to the Host', async () => {
    await readyForUpdate()
    const { serveWebDocument, forwardWebRequest } = await import('../src/web-document.ts')
    const handler = harness.protocolHandle.mock.calls[0]![1]
    for (const file of ['update-dialog.html', 'update-dialog.js', 'update-dialog.css', 'update-close.svg', 'mandatory-update.html']) {
      const request = new Request(`dsh-app://shell/${file}`)
      await handler(request)
      expect(serveWebDocument).toHaveBeenLastCalledWith(request, join('desktop-test-app', 'renderer'))
    }
    const tokens = new Request('dsh-app://shell/design-platform.css')
    await handler(tokens)
    expect(serveWebDocument).toHaveBeenLastCalledWith(tokens, join('desktop-test-app', 'lib/shell'))
    expect(forwardWebRequest).not.toHaveBeenCalled()
    expect((await handler(new Request('dsh-app://unknown/update-dialog.html'))).status).toBe(404)
  })

  it.each(([
    ['darwin', 'en'], ['darwin', 'zh-CN'], ['win32', 'en'], ['win32', 'zh-CN'], ['linux', 'en'], ['linux', 'zh-CN'],
  ] as const).flatMap(([platform, locale]) => [
    [platform, locale, true] as const, [platform, locale, false] as const,
  ]))('groups localized DevTools before quit on %s (%s, packaged=%s)', async (platform, locale, packaged) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform })
    harness.app.isPackaged = packaged
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    await readyForUpdate()
    const messages = locale === 'en' ? en : zh
    const menu = applicationMenuItems()
    const visible = menu.filter(item => item.visible !== false)
    expect(visible.map(item => item.role === 'quit' ? 'quit' : item.label ?? item.type)).toEqual([
      messages.aboutMenu, 'separator', messages.productSignOut, messages.checkUpdatesMenu,
      ...platform === 'linux' ? [] : [messages.cliCommandMenu],
      'separator', ...packaged ? [] : [messages.reloadPageMenu, messages.restartAppHostMenu],
      messages.toggleDevToolsMenu, 'separator',
      ...platform === 'darwin' ? [messages.hideApplication, messages.hideOtherApplications, messages.showAllApplications, 'separator'] : [],
      'quit',
    ])
    expect(visible.filter(item => item.role === 'toggleDevTools')).toEqual([
      { role: 'toggleDevTools', label: messages.toggleDevToolsMenu },
    ])
    if (platform === 'win32') {
      expect(harness.menu.mock.calls[0]![0]).toEqual([
        { role: 'toggleDevTools', visible: false },
        { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      ])
      expect(menu.every(item => item.visible !== false)).toBe(true)
    } else {
      expect(menu.filter(item => item.visible === false)).toEqual([
        { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      ])
    }
    const sender = harness.windows[0]!.webContents
    const nextLocale = locale === 'en' ? 'zh' : 'en'
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.localeChanged)![1](
      { sender, senderFrame: sender.mainFrame }, nextLocale,
    )
    const refreshed = platform === 'win32' ? applicationMenuItems()
      : harness.menu.mock.lastCall![0][0]!.submenu as MenuItemConstructorOptions[]
    expect(refreshed.filter(item => item.role === 'toggleDevTools' && item.visible !== false)).toEqual([
      { role: 'toggleDevTools', label: nextLocale === 'en' ? en.toggleDevToolsMenu : zh.toggleDevToolsMenu },
    ])
    expect(harness.windows[0]!.options).toMatchObject({ webPreferences: { devTools: true } })
  })

  it.each([
    ['darwin', true, 'en-US'],
    ['darwin', false, 'zh-CN'],
    ['win32', true, 'zh-CN'],
    ['win32', false, 'en-US'],
  ] as const)('offers the About command before other commands on %s (packaged=%s, locale=%s)', async (platform, packaged, locale) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform })
    harness.app.isPackaged = packaged
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const options = harness.app.setAboutPanelOptions.mock.calls[0]![0]
    const expected = JSON.parse(readFileSync(new URL('./expected/about-panel.json', import.meta.url), 'utf8')) as Record<string, unknown>
    const [about, separator] = submenu
    expect({ menu: [{ label: about!.label, role: about!.role }, separator], options: { ...options, iconPath: '<app icon>' } })
      .toEqual(expected[`${platform}:${locale}`])
    expect(options.iconPath).toBe(packaged ? join('desktop-test-resources', 'icon.png')
      : join('desktop-test-app', 'resources', 'icon-windows.png'))
    if (platform !== 'win32') { expect(about!.click).toBeUndefined(); return }
    // Windows reuses the dimmed update dialog because Electron's fallback is a bare message box.
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    const zh = locale === 'zh-CN'
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'info', title: zh ? '关于 Agent 助手' : 'About Agent 助手', message: 'Agent 助手',
      detail: zh ? '版本 V1.0.0' : 'Version V1.0.0', buttons: [zh ? '确定' : 'OK'], cancelId: 0,
    }))
    // A dialog that cannot open is logged, not surfaced as an unhandled rejection.
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('overlay unavailable'))
    ;(about!.click as () => void)()
    await vi.advanceTimersByTimeAsync(0)
    expect(console.error).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'overlay unavailable' }))
  })

  it('does not require gateway login to download an already available ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test', allowedAuthOrigins: ['https://login.example.com'],
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1', 0)
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('persists opt-in update evidence from the real main entry without private diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-main-update-journal-'))
    try {
      vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', directory)
      await readyForUpdate()
      harness.publishUpdate({ phase: 'error', failedOperation: 'download', version: '1.2.3', message: 'ENOSPC secret-url' })
      const checkUpdates = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)!.click as () => void
      checkUpdates()
      await vi.advanceTimersByTimeAsync(0)
      for (const host of harness.hosts) host.exited.resolve()
      harness.app.quit()
      await harness.quitCompleted.promise
      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      const contents = readFileSync(join(directory, files[0]!), 'utf8')
      const records = contents.trim().split('\n').map(line => JSON.parse(line) as { event: string })
      expect(records.map(row => row.event)).toEqual(expect.arrayContaining(['started', 'workspace-ready', 'state', 'check-requested', 'quit-requested']))
      expect(contents).toContain('ENOSPC')
      expect(contents).not.toContain('secret-url')
    } finally {
      // The existing teardown calls quit again; retain its journal until listeners are removed.
      harness.app.removeAllListeners('before-quit')
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts product IPC only from the current application top frame in the owned main window', async () => {
    await readyForUpdate()
    const sender = harness.windows[0]!.webContents
    for (const channel of [DESKTOP_IPC.updatesStatus, DESKTOP_IPC.updatesChannelGet, DESKTOP_IPC.deviceInfo]) {
      const handler = harness.handlers.get(channel)!
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).not.toThrow()
      for (const event of [
        { sender: {}, senderFrame: sender.mainFrame },
        { sender, senderFrame: { url: sender.mainFrame.url } },
        { sender, senderFrame: { url: 'http://127.0.0.1:40000/' } },
      ]) expect(() => handler(event)).toThrow('unowned renderer')
      const original = sender.mainFrame.url
      sender.mainFrame.url = 'http://127.0.0.1:40000/'
      expect(() => handler({ sender, senderFrame: sender.mainFrame })).toThrow('unowned renderer')
      sender.mainFrame.url = original
    }
  })

  it.each(['darwin', 'win32', 'linux'] as const)('limits native titlebar styling to macOS on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await readyForUpdate()
    const window = harness.windows[0]!
    expect(window.urls).toEqual(['dsh-app://app/'])
    if (platform === 'darwin') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' })
    } else if (platform === 'win32') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT } })
      expect(window.options).not.toHaveProperty('vibrancy')
      expect(harness.menu.mock.calls[0]![0]).toEqual([
        { role: 'toggleDevTools', visible: false },
        { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
      ])
    } else {
      expect(window.options).not.toHaveProperty('backgroundColor')
      expect(window.options).not.toHaveProperty('titleBarStyle')
      expect(window.options).not.toHaveProperty('vibrancy')
    }
    expect(harness.hosts).toHaveLength(1)
  })

  it.each([[false, '#f9fafb'], [true, '#1b1b1c']] as const)('paints the Windows workspace in its startup palette (dark=%s)', async (dark, color) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    harness.nativeTheme.shouldUseDarkColors = dark
    await readyForUpdate()
    expect(harness.windows[0]!.options).toMatchObject({ backgroundColor: color })
  })

  describe.each(['win32', 'darwin'] as const)('Host theme on %s', (platform) => {
    it.each([
      ['light', true, '#f9fafb'], ['dark', false, '#1b1b1c'],
      ['system', true, '#1b1b1c'], ['system', false, '#f9fafb'],
    ] as const)('applies %s with system dark=%s before revealing the workspace', async (source, systemDark, color) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      harness.nativeTheme.systemDark = systemDark
      await startAuthenticated()
      await harness.preparing.promise
      expect(harness.windows).toHaveLength(0)
      harness.prepared.resolve()
      await harness.hostStarted.promise
      const host = harness.hosts[0]!
      host.fetch.mockResolvedValue(Response.json({ localePreference: null, themePreference: source }))
      host.ready.resolve()
      await loginOperation
      const window = harness.windows[0]!
      expect(window.show).toHaveBeenCalledOnce()
      expect(harness.nativeTheme.themeSource).toBe(source)
      if (platform === 'win32') expect(window.setBackgroundColor).toHaveBeenLastCalledWith(color)
      else expect(window.options).toMatchObject({ backgroundColor: '#00000000', vibrancy: 'sidebar' })
      expect(host.fetch).toHaveBeenCalledOnce()
    })
  })

  it('tracks effective appearance changes and removes the listener when closed', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    for (const dark of [true, false]) {
      harness.nativeTheme.systemDark = dark
      harness.nativeTheme.emit('updated')
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith(dark ? '#1b1b1c' : '#f9fafb')
    }
    window.emit('closed')
    expect(harness.nativeTheme.listenerCount('updated')).toBe(0)
  })

  it('accepts only theme sources from the owned application main frame', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.nativeThemeSet)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    listener({ ...event, senderFrame: { url: 'dsh-app://app/' } }, 'dark')
    listener(event, 'invalid')
    expect(harness.nativeTheme.themeSource).toBe('system')
    listener(event, 'dark')
    expect(harness.nativeTheme.themeSource).toBe('dark')
    window.webContents.mainFrame.url = 'dsh-app://unowned/'
    listener(event, 'light')
    expect(harness.nativeTheme.themeSource).toBe('dark')
  })

  it('serves packaged shell documents instead of rejecting the shell origin', async () => {
    const { serveWebDocument } = await import('../src/web-document.ts')
    vi.mocked(serveWebDocument).mockResolvedValue(new Response('shell document'))
    await readyForUpdate()
    const handler = harness.protocolHandle.mock.calls[0]![1]
    const request = new Request('dsh-app://shell/update-dialog.html')
    expect(await (await handler(request)).text()).toBe('shell document')
    expect(serveWebDocument).toHaveBeenCalledWith(request, join('desktop-test-app', 'renderer'))
    expect((await handler(new Request('dsh-app://foreign/index.html'))).status).toBe(404)
  })

  it.each(['darwin', 'win32'] as const)('relays the %s fullscreen state on transitions and after each load', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await readyForUpdate()
    const window = harness.windows[0]!
    const sent = () => window.webContents.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.windowFullscreen)
    expect(sent()).toHaveLength(0)
    window.fullscreen = true
    window.emit('enter-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    // A reload re-registers the preload listener; the finished load resends
    // the current state so fullscreen CSS survives the reload.
    window.webContents.emit('did-finish-load')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, true])
    window.fullscreen = false
    window.emit('leave-full-screen')
    expect(sent().at(-1)).toEqual([DESKTOP_IPC.windowFullscreen, false])
    const relayed = sent().length
    window.destroyed = true
    window.emit('enter-full-screen')
    expect(sent()).toHaveLength(relayed)
  })

  it.each(['linux'] as const)('registers no fullscreen relay on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await readyForUpdate()
    const window = harness.windows[0]!
    window.emit('enter-full-screen')
    window.webContents.emit('did-finish-load')
    expect(window.webContents.send.mock.calls.filter(([channel]) => channel === DESKTOP_IPC.windowFullscreen)).toHaveLength(0)
  })

  it('covers the macOS vibrancy reattach gap with an opaque base while minimized or hidden', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await readyForUpdate()
    const window = harness.windows[0]!
    // Minimizing drops the vibrancy material and paints the theme's opaque fill.
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#f9fafb')
    // Restoring re-requests the material and returns to the transparent base.
    window.minimized = false
    window.emit('restore')
    expect(window.setVibrancy).toHaveBeenLastCalledWith('sidebar')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // Hiding under the dark palette picks the dark opaque fill.
    harness.nativeTheme.shouldUseDarkColors = true
    window.visible = false
    window.emit('hide')
    expect(window.setVibrancy).toHaveBeenLastCalledWith(null)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#1b1b1c')
    window.visible = true
    window.emit('show')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith('#00000000')
    // A destroyed window ends the backdrop updates.
    const applied = window.setVibrancy.mock.calls.length
    window.destroyed = true
    window.emit('minimize')
    expect(window.setVibrancy.mock.calls).toHaveLength(applied)
  })

  it.each(['win32', 'linux'] as const)('registers no backdrop swap on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await readyForUpdate()
    const window = harness.windows[0]!
    window.setBackgroundColor.mockClear()
    window.minimized = true
    window.emit('minimize')
    expect(window.setVibrancy).not.toHaveBeenCalled()
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
  })

  it('follows confirmed language and primary document palette without trusting other frames', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await readyForUpdate()
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    listener({ ...event, senderFrame: { url: 'dsh-app://app/' } }, 'zh-CN', '#ffffff', '#000000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.localeChanged)![1](event, 'zh')
    listener(event, 'zh-CN', 'rgb(249, 250, 251)', '#0f1115')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({ color: 'rgb(249, 250, 251)', symbolColor: '#0f1115' })
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: '复制', accelerator: '' }])
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.localeChanged)![1](event, 'en')
    listener(event, 'en', '#1b1b1c', '#f9fafb')
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: 'Copy', accelerator: '' }])
    window.setTitleBarOverlay.mockClear()
    listener(event, 'en', 'url(file:///bad)', '#fff')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, {}, '#fff', '#000')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#fff', symbolColor: '#000' })
    window.setTitleBarOverlay.mockClear()
    window.webContents.mainFrame.url = 'dsh-app://unowned/index.html'
    listener(event, 'zh-CN', '#fff', '#000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledTimes(4)
  })

  it('maps Windows caption menus to localized native commands and rejects foreign popup requests', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await readyForUpdate()
    const window = harness.windows[0]!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const appearance = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.localeChanged)![1](event, 'zh')
    appearance(event, 'zh-CN', '#fff', '#000')
    const handler = harness.handlers.get(DESKTOP_IPC.windowsMenu)!
    const foreignEvent = { ...event, sender: {} }
    expect(() => handler(foreignEvent, 'application', 48, 34)).toThrow('rejected sender')
    expect(() => handler(event, 'arbitrary-command', 48, 34)).toThrow('invalid popup request')
    expect(() => handler(event, 'application', NaN, 34)).toThrow('invalid popup request')
    const application = handler(event, 'application', 48, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '关于 Agent 助手', 'separator', zh.productSignOut, '检查更新…', '管理 dsh 命令…', 'separator', zh.toggleDevToolsMenu, 'separator', '退出',
    ])
    expect(harness.popup.mock.lastCall![0]).toMatchObject({ window, x: 48, y: 34 })
    expect(harness.popup.mock.lastCall![0].callback).toBeTypeOf('function')
    harness.popup.mock.lastCall![0].callback!()
    await application
    const edit = handler(event, 'edit', 104, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '撤销', '重做', 'separator', '剪切', '复制', '粘贴', '删除', 'separator', '全选',
    ])
    const commands = harness.menu.buildFromTemplate.mock.lastCall![0].filter(item => item.type !== 'separator')
    for (const [index, keyCode] of ['Z', 'Y', 'X', 'C', 'V', 'Delete', 'A'].entries()) {
      const click = commands[index]!.click as () => void
      click()
      const modifiers = keyCode === 'Delete' ? [] : ['control']
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 1, { type: 'keyDown', keyCode, modifiers })
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 2, { type: 'keyUp', keyCode, modifiers })
    }
    harness.popup.mock.lastCall![0].callback!()
    await edit
  })

  it.each(['darwin', 'linux'] as const)('declares the platform application menus, with the product File, Edit, and Window menus on macOS (%s)', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await readyForUpdate()
    const describeItem = (item: MenuItemConstructorOptions): string | undefined =>
      item.role ?? (item.type === 'separator' ? 'separator' : item.label)
    const template = harness.menu.buildFromTemplate.mock.calls
      .map(call => call[0])
      .find(items => items.some(item => item.role === 'editMenu'))
    if (template === undefined) throw new Error('application menu missing')
    expect(template.map(describeItem)).toEqual(platform === 'darwin'
      ? ['Desktop test', en.fileMenu, 'editMenu', 'windowMenu']
      : ['Application', 'editMenu'])
    const describeEdit = (items: MenuItemConstructorOptions[]): unknown[] => items.map(item => Array.isArray(item.submenu)
      ? [describeItem(item), describeEdit(item.submenu)]
      : [describeItem(item), item.accelerator, item.visible, item.acceleratorWorksWhenHidden].filter(value => value !== undefined))
    const edit = template.find(item => item.role === 'editMenu')!.submenu as MenuItemConstructorOptions[] | undefined
    expect(edit === undefined ? undefined : describeEdit(edit)).toEqual(platform === 'darwin'
      ? [['undo'], ['redo'], ['separator'], ['cut'], ['copy'], ['paste'],
        ['pasteAndMatchStyle', 'Shift+Command+V'], ['pasteAndMatchStyle', 'Option+Shift+Command+V', false, true],
        ['delete'], ['selectAll'], ['separator'],
        [en.substitutionsMenu, [['showSubstitutions'], ['separator'], ['toggleSmartQuotes'], ['toggleSmartDashes'], ['toggleTextReplacement']]],
        [en.speechMenu, [['startSpeaking'], ['stopSpeaking']]]]
      : undefined)
    const application = template[0]!.submenu as MenuItemConstructorOptions[]
    expect(application.filter(item => item.visible !== false).map(describeItem)).toEqual(platform === 'darwin'
      ? ['about', 'separator', en.productSignOut, en.checkUpdatesMenu, en.cliCommandMenu, 'separator', 'toggleDevTools', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']
      : ['about', 'separator', en.productSignOut, en.checkUpdatesMenu, 'separator', 'toggleDevTools', 'separator', 'quit'])
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledTimes(2)
  })

  it.each(['en-US', 'zh-CN'])('localizes macOS application commands without changing the application name (%s)', async (locale) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([locale])
    const originalName = harness.app.name
    harness.app.name = '@deepseek-ai/dsh-desktop'
    try {
      await startAuthenticated()
      await harness.preparing.promise
      const commands = applicationMenuItems().filter(item => item.visible !== false)
      await expect(JSON.stringify(commands, null, 2) + '\n')
        .toMatchFileSnapshot(`./expected/application-menu-${locale}.json`)
      expect(harness.app.name).toBe('@deepseek-ai/dsh-desktop')
    } finally { harness.app.name = originalName }
  })

  it.each(['http:', 'https:'] as const)('passes the %s Host cookie explicitly and attaches socket credentials only to the owned application origin and window', async (protocol) => {
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.url = `${protocol}//127.0.0.1:3080/`
    harness.hosts[0]!.ready.resolve()
    await loginOperation
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    expect(harness.connectWelcome).toHaveBeenCalledWith(`${protocol}//127.0.0.1:3080/`, 'dsh-desktop-session=test-private')
    expect(harness.removeLegacyHostCookies).toHaveBeenCalledWith(harness.hostCookies, `${protocol}//127.0.0.1:3080/`)
    const handler = harness.socketHeaders.mock.lastCall![1] as (
      details: { url: string; webContentsId: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void
    const callback = vi.fn()
    const socketProtocol = protocol === 'https:' ? 'wss:' : 'ws:'
    const details = { url: `${socketProtocol}//127.0.0.1:3080/api/remote.mux`, webContentsId: 42, requestHeaders: { Origin: 'dsh-app://app' } }
    handler(details, callback)
    await vi.waitFor(() => { expect(callback).toHaveBeenCalled() })
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      origin: `${protocol}//127.0.0.1:3080`, cookie: 'dsh-desktop-session=test-private', 'sec-fetch-site': 'same-origin',
    } })
    handler({ ...details, requestHeaders: { Origin: 'https://other.example' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    handler({ ...details, webContentsId: 43 }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: `${socketProtocol}//127.0.0.1:9999/api/remote.mux` }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: `${socketProtocol === 'wss:' ? 'ws:' : 'wss:'}//127.0.0.1:3080/api/remote.mux` }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  })

  it('logs a legacy Host cookie cleanup failure without blocking boot', async () => {
    const failure = new Error('cookie store unavailable')
    harness.removeLegacyHostCookies.mockRejectedValueOnce(failure)
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await loginOperation
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    await vi.waitFor(() => { expect(console.error).toHaveBeenCalledWith('desktop: legacy Host cookie cleanup failed', failure) })
    expect(harness.connectWelcome).toHaveBeenCalled()
  })

  it('registers the window-owned directory picker during startup and rejects foreign callers', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.directoryPick) as (event: IpcMainInvokeEvent) => Promise<string | null>
    expect(handler).toBeTypeOf('function')
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/workspace'] })
    await expect(handler(event)).resolves.toBe('/workspace')
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, { properties: ['openDirectory', 'createDirectory'] })
    window.webContents.mainFrame.url = 'https://other.example/'
    await expect(handler(event)).rejects.toThrow('unowned renderer')
  })

  it('retains macOS native editing actions on right-click and only copy for selected read-only text', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await readyForUpdate()
    const window = harness.windows[0]!
    const editFlags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    harness.menu.mockClear()

    window.webContents.emit('context-menu', {}, { isEditable: true, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([
      { role: 'undo', enabled: true, accelerator: '' }, { role: 'redo', enabled: false, accelerator: '' },
      { type: 'separator', accelerator: '' },
      { role: 'cut', enabled: true, accelerator: '' }, { role: 'copy', enabled: true, accelerator: '' },
      { role: 'paste', enabled: true, accelerator: '' }, { type: 'separator', accelerator: '' },
      { role: 'selectAll', enabled: true, accelerator: '' },
    ])
    expect(harness.popup).toHaveBeenCalledWith({ window })

    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, accelerator: '' }])

    harness.menu.mockClear()
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags })
    expect(harness.menu).not.toHaveBeenCalled()
  })

  it('opens message links externally while retaining same-origin application navigation', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as
      (details: { url: string }) => { action: string }
    const source = 'https://example.com/source?q=reference'
    expect(openWindow({ url: source })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledWith(source)
    harness.openExternal.mockClear()
    const external = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', external, 'https://example.com/document')
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/document')
    harness.openExternal.mockClear()
    const internal = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', internal, 'dsh-app://app/session/task-1')
    expect(internal.preventDefault).not.toHaveBeenCalled()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  async function readyForUpdate() {
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    await loginOperation
    return harness.hosts[0]!
  }

  it.each([
    ['win32', ['--updated'], true],
    ['win32', [], false],
    ['darwin', ['--updated'], false],
    ['linux', ['--updated'], false],
  ] as const)('raises the first workspace only for a Windows installer restart (%s, %j)', async (platform, args, raises) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform, argv: ['desktop', ...args] })
    await startAuthenticated()
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(0)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await loginOperation
    const window = harness.windows[0]!
    await window.shown.promise
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.moveTop).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.focus).toHaveBeenCalledTimes(raises ? 1 : 0)
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled()
    if (raises) {
      expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(window.moveTop.mock.invocationCallOrder[0]!)
    }
    window.destroy()
    harness.app.emit('second-instance')
    const replacement = harness.windows[1]!
    await replacement.shown.promise
    expect(replacement.show).toHaveBeenCalledOnce()
    expect(replacement.moveTop).not.toHaveBeenCalled()
    expect(replacement.setAlwaysOnTop).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', 'zh-CN'], ['win32', 'en-US'], ['darwin', 'zh-CN'], ['darwin', 'en-US'],
  ] as const)('records the restart confirmation on %s in %s', async (platform, language) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform })
    vi.spyOn(harness.app, 'getPreferredSystemLanguages').mockReturnValue([language])
    await readyForUpdate()
    harness.updateState = { phase: 'ready', version: '0.1.7-alpha.2' }
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    const { message, detail, buttons } = harness.dialog.showMessageBox.mock.lastCall![0] as MessageBoxOptions
    await expect(JSON.stringify({ message, detail, buttons }, null, 2) + '\n')
      .toMatchFileSnapshot(`./expected/update-restart-${platform}-${language}.json`)
  })

  /** Like readyForUpdate, but past backend readiness and the workspace reveal, so the Host answers quit inspections. */
  async function readyWorkspace() {
    const host = await readyForUpdate()
    await loginOperation
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    return host
  }

  it('hides the workspace before intentional Host shutdown can look like reconnection', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    window.show.mockClear()
    window.focus.mockClear()
    harness.app.quit()
    // The quit inspects the Host before hiding; nothing to interrupt means no dialog.
    await vi.advanceTimersByTimeAsync(0)
    expect(host.inspectQuit).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    harness.app.emit('second-instance')
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.trays[0]!.destroy).toHaveBeenCalledOnce()
  })

  it('routes closing through the tray confirmation and keeps the Host running', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(1)
    expect(harness.trays[0]!.image).toEqual({ path: join('desktop-test-resources', 'tray.ico') })
    expect(harness.backgroundNotice.markerPath).toBe(join(harness.app.getPath('userData'), 'background-close-confirmed'))
    window.show.mockClear()
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.backgroundNotice.close).toHaveBeenCalledOnce()
    harness.trays[0]!.emit('click')
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalled()
    harness.app.emit('second-instance')
    expect(window.show).toHaveBeenCalledTimes(2)
    // Locale changes relabel the tray together with the application menu.
    const relabels = harness.trays[0]!.setContextMenu.mock.calls.length
    harness.ipcOn.mock.calls.find(call => call[0] === DESKTOP_IPC.localeChanged)![1]({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, 'zh')
    expect(harness.trays[0]!.setContextMenu.mock.calls.length).toBe(relabels + 1)
  })

  it('hides a macOS owner with a mandatory view without quitting or stopping the Host', async () => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin' })
    harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
      show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
    } })))
    const host = await readyWorkspace()
    await harness.policyBlocked.promise
    const window = harness.windows[0]!
    const hides = window.hide.mock.calls.length
    window.close()
    expect(window.hide).toHaveBeenCalledTimes(hides + 1)
    expect(window.isDestroyed()).toBe(false)
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    expect(host.inspectQuit).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    harness.app.emit('activate')
    expect(window.show).toHaveBeenCalled()
  })

  it('keeps the workspace visible while acknowledgement is pending and ignores a destroyed window', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    const approval = Promise.withResolvers<() => void>()
    harness.backgroundNotice.close.mockImplementationOnce((hide) => { approval.resolve(hide) })
    window.close()
    const hide = await approval.promise
    expect(window.hide).not.toHaveBeenCalled()
    window.destroy()
    hide()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('focuses an existing shell dialog instead of replacing it with a close confirmation', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.shellDialog.isOpen = true
    window.close()
    expect(harness.shellDialog.focus).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
  })

  it('leaves macOS fullscreen before hiding on close and reopens the hidden window on activate', async () => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    await readyWorkspace()
    const window = harness.windows[0]!
    expect(harness.trays).toHaveLength(0)
    window.fullscreen = true
    window.close()
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.hide).toHaveBeenCalledOnce()
    expect(harness.backgroundNotice.close).not.toHaveBeenCalled()
    window.show.mockClear()
    harness.app.emit('activate', {}, false)
    expect(window.show).toHaveBeenCalledOnce()
    harness.app.emit('activate', {}, true)
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('skips the confirmation during a macOS shutdown but asks again once a cancelled shutdown returns focus', async () => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin', arch: 'arm64', resourcesPath: 'desktop-test-resources' })
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.powerMonitor.emit('shutdown')
    // Another application vetoed the shutdown; the user comes back to the window.
    window.emit('focus')
    window.close()
    expect(window.isDestroyed()).toBe(false)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(host.stop).not.toHaveBeenCalled()
    harness.powerMonitor.emit('shutdown')
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('drops a pending confirmation when a bypassing quit starts first', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    const inspected = Promise.withResolvers<{ activeTasks: boolean; scheduledTasks: boolean }>()
    host.inspectQuit.mockReturnValue(inspected.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    inspected.resolve({ activeTasks: true, scheduledTasks: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('asks before quitting when the Host reports interruptible work and cancels without stopping anything', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: true })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: en.quitTitle, detail: en.quitActiveAndScheduledTasks, buttons: [en.quit, en.cancel], defaultId: 0, cancelId: 1,
    }))
    expect(window.hide).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.trays[0]!.destroy).not.toHaveBeenCalled()
    // A second request while the box is open joins it instead of stacking another.
    const pending = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    harness.dialog.showMessageBox.mockReturnValue(pending.promise)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(host.inspectQuit).toHaveBeenCalledTimes(2)
    pending.resolve({ response: 0, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('warns about running tasks when the inspection fails and quits directly on session end or a development restart', async () => {
    harness.app.isPackaged = false
    const host = await readyWorkspace()
    host.inspectQuit.mockRejectedValue(new Error('desktop quit: inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: en.quitActiveTasks }))
    expect(host.stop).not.toHaveBeenCalled()
    const restart = applicationMenuItems().find(item => item.label === en.restartAppHostMenu)!
    harness.dialog.showMessageBox.mockClear()
    ;(restart as { click: () => void }).click()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('does not block a Windows session end on the quit confirmation', async () => {
    const host = await readyWorkspace()
    const window = harness.windows[0]!
    host.inspectQuit.mockResolvedValue({ activeTasks: true, scheduledTasks: false })
    // The session-end question alone proves nothing: another application can veto it silently.
    window.emit('query-session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(false)
    expect(window.hide).toHaveBeenCalledOnce()
    window.emit('session-end', { reasons: ['shutdown'] })
    window.close()
    expect(window.isDestroyed()).toBe(true)
    // Electron follows the last closed window with window-all-closed, which quits on Windows.
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(host.inspectQuit).not.toHaveBeenCalled()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('defers the downloaded-update confirmation until the hidden window is shown again', async () => {
    await readyWorkspace()
    const window = harness.windows[0]!
    harness.updateState = { phase: 'available', version: '1.0.1' }
    harness.updateDownload.mockImplementation(async () => { harness.updateState = { phase: 'ready', version: '1.0.1' }; return harness.updateState })
    window.close()
    window.visible = false
    const opened = invoke(DESKTOP_IPC.updatesOpen, 'app') as Promise<void>
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1', 0)
    expect(harness.updateInstall).not.toHaveBeenCalled()
    window.visible = true
    window.emit('show')
    await opened
    expect(harness.updateInstall).toHaveBeenCalledWith('1.0.1', 0)
  })

  it('reports file cleanup failure without ending Host shutdown early', async () => {
    const host = await readyForUpdate()
    const failure = new Error('image cleanup failed')
    fileDrag.dispose.mockRejectedValueOnce(failure)
    harness.app.quit()
    await host.stopping.promise
    await vi.waitFor(() => { expect(console.error).toHaveBeenCalledWith(failure) })
    expect(harness.app.quit).toHaveBeenCalledOnce()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(2)
  })

  it('waits for image cleanup before stopping the Host for installation', async () => {
    const host = await readyForUpdate()
    const cleanup = Promise.withResolvers<undefined>()
    fileDrag.dispose.mockReturnValueOnce(cleanup.promise)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(fileDrag.dispose).toHaveBeenCalledOnce() })
    expect(host.stop).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('continues installation after reporting file cleanup failure', async () => {
    const host = await readyForUpdate()
    const failure = new Error('temporary file busy')
    fileDrag.dispose.mockRejectedValueOnce(failure)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    expect(console.error).toHaveBeenCalledWith(failure)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('finishes quitting when the native window is destroyed before its closed listener clears ownership', async () => {
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.destroyed = true
    window.hide.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => { harness.app.quit() }).not.toThrow()
    expect(window.hide).not.toHaveBeenCalled()
    await host.stopping.promise
    window.emit('closed')
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('shares the failed-check deadline across focus and resume, while explicit checks reset polling', async () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', '1000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS', '4000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_JITTER', '0')
    harness.updateCheck.mockResolvedValue({ phase: 'error', failedOperation: 'check', message: 'offline' })
    const host = await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1999)
    harness.windows[0]!.emit('focus')
    harness.powerMonitor.emit('resume')
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.updateCheck).toHaveBeenCalledTimes(2)
    harness.updateCheck.mockResolvedValue({ phase: 'idle' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.updateCheck).toHaveBeenCalledTimes(4)
    harness.app.quit()
    try {
      await host.stopping.promise
      await vi.advanceTimersByTimeAsync(10_000)
      harness.powerMonitor.emit('resume')
      expect(harness.updateCheck).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally { host.exited.resolve(); await harness.quitCompleted.promise }
  })

  it('blocks subsequent product operations without stopping the Host and clears only on a fresh no-force policy', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', '{invalid environment override}')
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 40005,
      data: { show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/' } }))
    vi.stubGlobal('fetch', request)
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    const modal = harness.windows[0]!
    expect(modal).toBeDefined()
    expect(harness.windows).toHaveLength(1)
    const status = harness.handlers.get(MANDATORY_IPC.status)!
    const action = harness.handlers.get(MANDATORY_IPC.action)!
    const owned = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    expect(status(owned)).toMatchObject({ policy: { blocking: true } })
    const unowned = [
      { ...owned, sender: {} },
      { ...owned, senderFrame: { url: 'dsh-app://app/index.html' } },
      { ...owned, senderFrame: { url: 'https://untrusted.example.com/' } },
    ]
    for (const event of unowned) {
      expect(() => status(event)).toThrow('unowned renderer')
      expect(() => action(event, 'download', '1.0.1-nightly.1')).toThrow('unowned renderer')
    }
    expect(() => action(owned, 'open-arbitrary-url')).toThrow('invalid action')
    expect(() => action(owned, 'download')).toThrow('missing confirmed version')
    expect(() => action(owned, 'install', 123)).toThrow('missing confirmed version')
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.updateDownload).not.toHaveBeenCalled()
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 500 }, { status: 503 }))
    await action(owned, 'refresh')
    expect(modal.isDestroyed()).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
    await action(owned, 'refresh')
    expect(modal.isDestroyed()).toBe(false)
    await vi.advanceTimersByTimeAsync(150)
    expect(modal.isDestroyed()).toBe(false)
    expect(modal.webContents.send.mock.calls.at(-1)).toMatchObject([MANDATORY_IPC.state, { policy: { blocking: false } }])
    expect(host.stop).not.toHaveBeenCalled()
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({
      'x-client-bundle-id': '', 'x-client-platform': 'desktop-win', 'x-client-version': '1.2.3',
      'x-client-arch': 'x64', 'x-client-update-channel': 'stable', 'x-client-bundled-dsh-version': '1.0.0',
      'x-client-locale': 'en_US', 'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    })
  })

  it('keeps one checking dialog open until the manual check settles, then reports the current version', async () => {
    await readyForUpdate()
    const checked = Promise.withResolvers<DesktopUpdateState>()
    const checking = Promise.withResolvers<AbortSignal>()
    const requested = Promise.withResolvers<undefined>()
    harness.updateCheck.mockImplementationOnce(() => { requested.resolve(undefined); return checked.promise })
    harness.dialog.showMessageBox.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      checking.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    }).mockImplementationOnce(() => {
      expect((harness.dialog.showMessageBox.mock.calls[0]![0] as { signal: AbortSignal }).signal.aborted).toBe(false)
      return Promise.resolve({ response: 0 })
    })
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    expect(action?.click).toBeTypeOf('function')
    // Electron supplies menu arguments that this callback does not consume.
    Reflect.apply(action!.click!, undefined, [])
    const prompt = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    const signal = await checking.promise
    await requested.promise
    expect(signal.aborted).toBe(false)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    checked.resolve({ phase: 'idle' })
    await prompt
    expect(signal.aborted).toBe(true)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'You’re up to date!', detail: 'Current version: 1.0.0',
    }))
  })

  it.each([
    { phase: 'available', version: '1.0.3' },
    { phase: 'idle' },
    { phase: 'error', failedOperation: 'check', message: 'Old feed unavailable' },
  ] satisfies DesktopUpdateState[])('discards a manual check result after switching channel: $phase', async (result) => {
    await readyForUpdate()
    const checked = Promise.withResolvers<DesktopUpdateState>()
    const requested = Promise.withResolvers<undefined>()
    harness.updateCheck.mockImplementationOnce(() => { requested.resolve(undefined); return checked.promise })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const action = applicationMenuItems().find(item => item.label === 'Check for Updates…')
    Reflect.apply(action!.click!, undefined, [])
    const prompt = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    await requested.promise
    await invoke(DESKTOP_IPC.updatesChannelSet, 'app', 'stable')
    checked.resolve(result)
    await prompt
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
  })

  it('reports a manual check failure without offering a download', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'error', failedOperation: 'check', message: 'Feed unavailable' })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: 'Could not check for updates. Please try again later.', technicalDetails: 'Feed unavailable' }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('reports a stale download confirmation as a download failure', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.updateDownload.mockRejectedValueOnce(new Error('desktop update: download confirmation is stale'))
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: en.updateDownloadFailed, technicalDetails: 'desktop update: download confirmation is stale' }))
  })

  it('keeps policy failures silent while an ordinary update proceeds', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ code: 500 }, { status: 503 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.dialog.showMessageBox.mockClear()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
    expect(messages).not.toContain(en.mandatoryUnavailable)
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1', 0)
  })

  it('does not wait for a pending policy request before proceeding with an ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    const operation = Promise.resolve().then(async () => {
      await readyForUpdate()
      await invoke(DESKTOP_IPC.updatesOpen, 'app')
    })
    try {
      await vi.waitFor(() => { expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1', 0) })
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('lets a confirmed mandatory policy preempt an ordinary result dialog', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    const available = Promise.withResolvers<AbortSignal>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.dialog.showMessageBox.mockImplementation(({ signal, message }: { signal?: AbortSignal; message: string }) => {
      if (message !== en.updateAvailable.replace('{version}', '1.0.1-nightly.1') || signal === undefined) return Promise.resolve({ response: 1 })
      available.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    })
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    Reflect.apply(action!.click!, undefined, [])
    const operation = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    try {
      const signal = await available.promise
      policy.resolve(Response.json({ code: 40005,
        data: { show_content: { title: 'Update required', detail: 'Please update' },
          desktop_app_link: 'https://downloads.example.com/' } }))
      await harness.policyBlocked.promise
      expect(signal.aborted).toBe(true)
      await operation
      expect(harness.updateDownload).not.toHaveBeenCalled()
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('downloads on the first click and opens installation confirmation only after readiness', async () => {
    await readyForUpdate()
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    const downloading = Promise.withResolvers<DesktopUpdateState>()
    const started = Promise.withResolvers<undefined>()
    harness.updateDownload.mockImplementationOnce(async (version) => {
      harness.updateState = { phase: 'downloading', version }
      started.resolve(undefined)
      return downloading.promise
    })
    const action = invoke(DESKTOP_IPC.updatesOpen, 'app')
    await started.promise
    const repeated = invoke(DESKTOP_IPC.updatesOpen, 'app')
    await repeated
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: en.updateDownloadInProgress, detail: en.updateDownloadDetail,
    }))
    harness.dialog.showMessageBox.mockClear()
    const checks = harness.updateCheck.mock.calls.length
    const check = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)!.click as () => void
    check()
    await vi.waitFor(() => { expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: en.updateDownloadInProgress, detail: en.updateDownloadDetail, buttons: [en.updateClose],
    })) })
    expect(harness.updateCheck).toHaveBeenCalledTimes(checks)
    harness.shellDialog.isOpen = true
    check()
    expect(harness.shellDialog.focus).toHaveBeenCalled()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    harness.shellDialog.isOpen = false
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1', 0)
    expect(harness.updateInstall).not.toHaveBeenCalled()
    downloading.resolve({ phase: 'ready', version: '1.0.1-nightly.1' })
    await Promise.all([action, repeated])
    expect(harness.updateInstall).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1', 0)
    await harness.updateCheck()
    expect(harness.updateInstall).toHaveBeenCalledOnce()
  })

  it.each(['downloading', 'verifying'] as const)('explains %s when checking from the menu without another update operation', async (phase) => {
    await readyForUpdate()
    harness.updateState = { phase, version: '1.0.1-nightly.1', percent: 21 }
    const checks = harness.updateCheck.mock.calls.length
    const check = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)!.click as () => void
    check()
    await vi.waitFor(() => { expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: phase === 'downloading' ? en.updateDownloadInProgress : en.updateVerifying,
      detail: phase === 'downloading' ? en.updateDownloadDetail : '', buttons: [en.updateClose], cancelId: 0,
    })) })
    expect(harness.updateCheck).toHaveBeenCalledTimes(checks)
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(harness.updateState.phase).toBe(phase)
    check()
    await vi.waitFor(() => { expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2) })
    expect(harness.updateCheck).toHaveBeenCalledTimes(checks)
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(harness.updateState.phase).toBe(phase)
  })

  it.each(['downloading', 'verifying'] as const)('falls back to native %s status without changing the message or restarting the update', async (phase) => {
    await readyForUpdate()
    harness.updateState = { phase, version: '1.0.1-nightly.1', percent: 21 }
    const checks = harness.updateCheck.mock.calls.length
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('overlay unavailable'))
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    const first: unknown = harness.dialog.showMessageBox.mock.calls[0]!.at(-1)
    expect(first).toEqual(expect.objectContaining(harness.dialog.showMessageBox.mock.calls[1]!.at(-1)))
    expect(first).toEqual(expect.objectContaining({
      type: 'info', message: phase === 'downloading' ? en.updateDownloadInProgress : en.updateVerifying,
      detail: phase === 'downloading' ? en.updateDownloadDetail : '', buttons: [en.updateClose],
    }))
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'overlay unavailable' }))
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(harness.updateCheck).toHaveBeenCalledTimes(checks)
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(harness.updateState.phase).toBe(phase)
  })

  it('logs native status fallback failure without rejecting the user action', async () => {
    await readyForUpdate()
    harness.updateState = { phase: 'downloading', version: '1.0.1-nightly.1', percent: 21 }
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('overlay unavailable'))
      .mockRejectedValueOnce(new Error('native unavailable'))
    await expect(invoke(DESKTOP_IPC.updatesOpen, 'app')).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'native unavailable' }))
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(harness.updateState.phase).toBe('downloading')
  })

  it('does not lock or stop tasks when restart confirmation is dismissed', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks admission after approval and rejects work that started during confirmation', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow(/New tasks/u)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('warns about active tasks and waits for a graceful Host exit after approval', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValue(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Tasks are still in progress', buttons: ['Stop tasks and update', 'Update later'],
    }))
    expect(host.stop).toHaveBeenCalledWith(true)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('unlocks admission without stopping the Host when request draining fails', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('task inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow('task inspection timed out')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it.each([false, true])('waits for macOS to leave fullscreen before installation confirmation, mandatory: %s', async (mandatory) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin' })
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    const window = harness.windows[0]!
    const dialogOwner = mandatory ? harness.views.find(item => item.urls.includes('dsh-app://shell/mandatory-update.html'))! : window
    const baseline = { leave: window.listenerCount('leave-full-screen'), closed: window.listenerCount('closed') }
    window.fullscreen = true
    window.setFullScreen.mockImplementation(() => {})
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(window.setFullScreen).toHaveBeenCalledWith(false) })
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    if (mandatory) expect(harness.handlers.get(MANDATORY_IPC.status)!({ sender: dialogOwner.webContents, senderFrame: dialogOwner.webContents.mainFrame })).not.toHaveProperty('confirmation')
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    window.fullscreen = false
    window.emit('leave-full-screen')
    if (mandatory) await answerMandatory('install', dialogOwner)
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    expect(window.listenerCount('leave-full-screen')).toBe(baseline.leave)
    expect(window.listenerCount('closed')).toBeLessThanOrEqual(baseline.closed)
  })

  it('keeps the Host running after a fullscreen timeout and accepts a later retry', async () => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin' })
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.fullscreen = true
    window.setFullScreen.mockImplementation(() => {})
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject({ kind: 'fullscreen-timeout',
      message: 'Could not exit fullscreen. Exit fullscreen, then retry the update.' })
    await vi.waitFor(() => { expect(window.setFullScreen).toHaveBeenCalledWith(false) })
    await vi.advanceTimersByTimeAsync(5000)
    await rejected
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
    window.setFullScreen.mockImplementation((flag) => { window.fullscreen = flag; window.emit('leave-full-screen') })
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const retrying = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(retrying).resolves.toBe(true)
  })

  it.each([false, true])('cancels installation when the fullscreen product window closes, mandatory: %s', async (mandatory) => {
    vi.stubGlobal('process', { ...process, on: vi.fn(), removeListener: vi.fn(), platform: 'darwin' })
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    const window = harness.windows[0]!
    const baseline = { leave: window.listenerCount('leave-full-screen'), closed: window.listenerCount('closed') }
    window.fullscreen = true
    window.setFullScreen.mockImplementation(() => {})
    const preparing = harness.prepareUpdate()
    await vi.waitFor(() => { expect(window.setFullScreen).toHaveBeenCalledWith(false) })
    window.destroy()
    await expect(preparing).resolves.toBe(false)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(window.listenerCount('leave-full-screen')).toBe(baseline.leave)
  })

  async function answerMandatory(action: 'install' | 'later', modal = harness.windows[0]!) {
    const event = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    await vi.waitFor(() => {
      expect(harness.handlers.get(MANDATORY_IPC.status)!(event)).toHaveProperty('confirmation')
    })
    const view = harness.handlers.get(MANDATORY_IPC.status)!(event) as { confirmation: { version: string; revision: number } }
    await harness.handlers.get(MANDATORY_IPC.action)!(event, action, view.confirmation.version, view.confirmation.revision)
  }

  it('does not replace a Host whose failed stop has not confirmed process exit', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toThrow('child did not exit')
    await host.stopping.promise
    host.exited.reject(new Error('child did not exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'child did not exit' })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    const auth = harness.authWindows[0]!
    expect(await harness.handlers.get(PRODUCT_IPC.request)!({ sender: auth.webContents, senderFrame: auth.webContents.mainFrame }, 'session')).toMatchObject({ value: { state: 'stopFailed' } })
    expect(harness.hosts).toHaveLength(1)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
  })

  it('reports a window construction failure without requiring a window', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    harness.failWindow(new Error('window creation failed'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.windows).toHaveLength(0)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('window creation failed')
  })

  it('accepts Web fatal reports only from the primary application frame', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const frame = { url: 'dsh-app://app/' }
    Object.assign(window.webContents, { mainFrame: frame })
    const handler = harness.handlers.get(DESKTOP_IPC.bootFailed)! as (event: unknown, message: unknown) => void
    const event = { sender: window.webContents, senderFrame: frame }
    expect(() => { handler({ ...event, senderFrame: { url: 'https://other.example/' } }, 'untrusted') }).toThrow('unowned renderer')
    expect(() => { handler({ ...event, senderFrame: { ...frame } }, 'subframe') }).toThrow('non-primary frame')
    expect(() => { handler(event, {}) }).toThrow('must be text')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    handler(event, 'client mount failed')
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('client mount failed')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain(join(harness.app.getPath('logs'), 'crash-test.log'))
    expect(writeCrashReport).toHaveBeenCalledWith(harness.app.getPath('logs'), expect.objectContaining({ source: 'web-boot', phase: 'running' }))
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores subresource failures and navigation cancellation but reports a failed main document', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/image.png', false)
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/', true)
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('Desktop page failed to load')
    expect(writeCrashReport).toHaveBeenCalledWith(harness.app.getPath('logs'), expect.objectContaining({ source: 'renderer' }))
  })

  it.each(['preload', 'renderer'])('retains the document after a fatal %s failure and reports only the first error', async (kind) => {
    await readyForUpdate()
    const window = harness.windows[0]!
    if (kind === 'preload') window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    harness.prepared.reject(new Error('backend also failed'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).not.toContain('secondary failure')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores clean renderer exits and exits of a destroyed window', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    window.destroy()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports a rejected document load without navigating to a recovery page', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('document missing'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('document missing')
    expect(harness.hosts).toHaveLength(0)
  })

  it('writes operation history under the authenticated account home', async () => {
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const record = parsePluginOperationRecord({ runId: 'c254ab28-97c9-4382-95e6-2db9c66f98c8', transportDropped: 0,
      operation: { id: 'c254ab28-97c9-4382-95e6-2db9c66f98c9', time: '2026-10-20T00:00:00.000Z',
        reason: 'bundle', phase: 'started', target: 'test', stage: 'enable' } })!
    harness.hosts[0]!.onPluginOperation!(record)
    const file = join(harness.app.getPath('userData'), 'product', 'users', 'user-a', 'logs', 'plugin-operations', 'operations.jsonl')
    await vi.waitFor(() => { expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(record) })
    expect(existsSync(join(harness.app.getPath('logs'), 'plugin-operations'))).toBe(false)
  })

  it('attaches the primary window\'s error-level console output to a running-phase Host crash report', async () => {
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await loginOperation
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const window = harness.windows[0]!
    window.webContents.emit('console-message', { level: 'info', message: 'boot ok', sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 1 })
    window.webContents.emit('console-message', {
      level: 'error', message: 'client-modules: bundle script plugins/??a/client.js&rev=1 failed to load',
      sourceId: 'dsh-app://app/assets/entry.js', lineNumber: 12,
    })
    host.onFailure!(new Error('dsh desktop host exited with 1: fatal uncaught exception: ENOENT'))
    await host.stopping.promise
    expect(writeCrashReport).toHaveBeenCalledOnce()
    const [directory, report] = vi.mocked(writeCrashReport).mock.calls[0]!
    expect(directory).toBe(harness.app.getPath('logs'))
    expect(report.source).toBe('host')
    expect(report.phase).toBe('running')
    expect(report.error).toBeInstanceOf(Error)
    expect((report.error as Error).message).toContain('fatal uncaught exception: ENOENT')
    expect(report.rendererConsole).toEqual(['dsh-app://app/assets/entry.js:12 client-modules: bundle script plugins/??a/client.js&rev=1 failed to load'])
    expect(report.app).toMatchObject({ name: 'Desktop test', version: '1.0.0', platform: process.platform, locale: 'en' })
    expect(report.time).toBeInstanceOf(Date)
    host.exited.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.windows[0]!.isDestroyed()).toBe(true)
    expect(harness.hosts).toHaveLength(1)
  })

  it.each([false, true])('bounds diagnostic Worker cleanup on quit (stuck=%s)', async (stuck) => {
    const report = Promise.withResolvers<{ appended: boolean; timedOut: boolean; cancelled: boolean }>()
    let reportSignal: AbortSignal | undefined
    vi.mocked(runOperationReportJob).mockImplementationOnce((_input, _options, signal) => { reportSignal = signal; return report.promise })
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await harness.dialogShown.promise
    expect(runOperationReportJob).toHaveBeenCalledOnce()
    let completed = false
    void harness.quitCompleted.promise.then(() => { completed = true })
    host.exited.resolve()
    window.emit('session-end', { reasons: ['shutdown'] })
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => { expect(reportSignal?.aborted).toBe(true) })
    expect(completed).toBe(false)
    if (stuck) {
      await vi.advanceTimersByTimeAsync(500)
      expect(console.error).toHaveBeenCalledWith('dsh desktop: operation report Worker has not exited; continuing shutdown')
    } else report.resolve({ appended: false, timedOut: false, cancelled: true })
    await vi.advanceTimersByTimeAsync(0)
    await harness.quitCompleted.promise
    report.resolve({ appended: false, timedOut: false, cancelled: true })
  })

  it.each([{ response: 0, stuck: false }, { response: 1, stuck: false }, { response: 2, stuck: false },
    { response: 0, stuck: true }])('waits for Host exit and bounds Worker cleanup for recovery $response (stuck=$stuck)', async ({ response, stuck }) => {
    let finishReport!: (result: { appended: boolean; timedOut: boolean; cancelled: boolean }) => void
    let reportSignal: AbortSignal | undefined
    vi.mocked(runOperationReportJob).mockImplementationOnce(async (_input, _options, signal) => {
      reportSignal = signal
      return new Promise((resolve) => { finishReport = resolve })
    })
    harness.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false })
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await loginOperation
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    harness.windows[0]!.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await host.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    host.exited.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => { expect(reportSignal?.aborted).toBe(true) })
    expect(harness.app.quit).not.toHaveBeenCalled()
    if (stuck) await vi.advanceTimersByTimeAsync(500)
    else finishReport({ appended: false, timedOut: false, cancelled: true })
    await harness.quitCompleted.promise
    if (stuck) {
      expect(console.error).toHaveBeenCalledWith('dsh desktop: operation report Worker has not exited; continuing shutdown')
      finishReport({ appended: false, timedOut: false, cancelled: true })
    }
    expect(harness.app.relaunch).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
    expect(harness.disableAllPlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    if (response === 2) {
      expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
        profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1789555200000', homePatch: 'unchanged',
      })
    } else {
      expect(console.info).not.toHaveBeenCalled()
    }
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares an independent plugin profile for the unpackaged Host', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await startAuthenticated()
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: process.execPath, runtime: project,
      primaryRuntime: 'test-primary-runtime', profile: 'desktop-test-profile' })
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

})

it('disables native product events for a disabled Desktop launch', async () => {
  harness.analyticsEnabled = false
  await startAuthenticated()
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  harness.hosts[0]!.ready.resolve()
  await harness.navigated.promise
  expect(harness.analytics).not.toHaveBeenCalled()
  harness.analyticsEnabled = true
})
