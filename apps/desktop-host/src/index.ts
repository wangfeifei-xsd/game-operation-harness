/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { formatFatalDiagnostic } from './fatal-diagnostic.ts'
import { loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { HarnessAuthClient, HarnessAuthError } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import { readHarnessConfig, harnessUserHome } from '@deepseek-ai/dsh-host-harness-product/config'
import { harnessComposition, harnessDefaults } from '@deepseek-ai/dsh-host-harness-product/composition'
import { installHarnessAuthorization } from '@deepseek-ai/dsh-host-harness-product/authorization'
import { installProxyFromConfig } from '@deepseek-ai/dsh-http-proxy'
import { localDragResource } from './file-drag.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installOperationDiagnostics } from './operation-diagnostics.ts'
import { DesktopAuthenticationEnd, receiveDesktopSecret } from './authentication.ts'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'

async function main(): Promise<void> {
  const runId = randomUUID() as PluginOperationRunId
  const authentication = receiveDesktopSecret(process)
  if (process.connected) process.send?.({ type: 'starting', runId }, (error) => {
    if (error !== null) authentication.dispose()
  })
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  let secret: string
  try {
    secret = await authentication.secret
    authentication.signal.throwIfAborted()
  } catch (error) {
    if (!(error instanceof DesktopAuthenticationEnd)) throw error
    if (error.kind === 'shutdown') await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    return
  }
  const input = await authentication.product
  const config = readHarnessConfig(input.environment, input.configDirectory)
  const extensionEnvironment = { ...process.env }
  const disposeProxy = await installProxyFromConfig(config.proxy)
  const client = new HarnessAuthClient(config)
  const verify = async (): Promise<void> => {
    authentication.signal.throwIfAborted()
    const verified = await client.session(input.token)
    authentication.signal.throwIfAborted()
    if (verified.user.user_id !== input.user.user_id ||
      verified.session_id !== input.sessionId) throw new HarnessAuthError(401, 'HARNESS_IDENTITY_CHANGED', '桌面启动身份不一致')
  }
  await client.bootstrap()
  await verify()
  const home = harnessUserHome(config, input.user.user_id)
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  // Set before the launch-environment snapshot and profile evaluation; empty means the payload sits beside the runtime directory.
  process.env.DSH_PRIMARY_RUNTIME = process.argv[4] || join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  let stopping: Promise<void> | undefined
  let paused: ReturnType<typeof Promise.withResolvers<void>> | undefined
  let authorize: (() => Promise<void>) | undefined
  const failProduct = (error: HarnessAuthError): void => {
    process.send?.({ type: 'product-failed', status: error.status, code: error.code, message: error.message }, () => undefined)
    void stop()
    setTimeout(() => { process.exit(1) }, config.auth.shutdownGraceMs).unref()
  }
  const application = runProfile({
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: [],
    product: {
      home, patches: [], defaults: patches => harnessDefaults(patches, config, extensionEnvironment),
      transform: patches => harnessComposition(patches, config, home),
      prepare: async (ctx) => {
        await verify()
        ctx.provide('fileDeployment', true)
        ctx.provide('fileDeploymentHome', home)
        ctx.provide('webStartup', { host: '127.0.0.1', port: 0, openBrowser: false, trustedHosts: [] })
        ctx.effect(() => disposeProxy)
        authorize = installHarnessAuthorization(ctx, config, input, failProduct, () => process.connected &&
          !authentication.signal.aborted && stopping === undefined, async () => { await paused?.promise })
        ctx.plugin(DesktopAuthentication, { readSecret: () => secret })
      },
    },
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const stop = (): Promise<void> => stopping ??= (async () => {
    paused?.resolve(); paused = undefined
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    // A handle a disposed plugin left open would otherwise keep the Host alive past the shell's graceful
    // deadline; a startup failure keeps its own diagnostic exit.
    if (running !== undefined) process.exit()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'product-suspend') { paused ??= Promise.withResolvers<void>(); return }
    if (message.type === 'product-resume' && 'requestId' in message && Number.isSafeInteger(message.requestId)) {
      const requestId = message.requestId
      void verify().then(async () => {
        if (stopping !== undefined) return
        paused?.resolve(); paused = undefined
        await send({ type: 'product-resumed', requestId })
      }).catch((error: unknown) => { failProduct(error instanceof HarnessAuthError ? error : new HarnessAuthError(503,
        'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用')) })
      return
    }
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      const abort = new AbortController()
      dragReads.set(requestId, abort)
      const task = (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          if (authorize === undefined) throw new Error('产品认证尚未就绪')
          await authorize()
          const resource = await localDragResource(ctx, address, abort.signal)
          await send({ type: 'file-drag-resource', requestId, resource })
        } catch (error) {
          if (!abort.signal.aborted) console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        } finally { dragReads.delete(requestId) }
      })().catch((error: unknown) => { console.error(error) })
      dragTasks.add(task)
      void task.finally(() => { dragTasks.delete(task) })
      return
    }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        if (authorize === undefined) throw new Error('产品认证尚未就绪')
        await authorize()
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  const onAuthenticationEnd = (): void => { void stop() }
  authentication.signal.addEventListener('abort', onAuthenticationEnd, { once: true })
  if (authentication.signal.aborted) onAuthenticationEnd()
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  const canPublish = (): boolean => stopping === undefined && process.connected && !authentication.signal.aborted
  if (!canPublish()) return
  ctx.effect(() => () => {
    authentication.signal.removeEventListener('abort', onAuthenticationEnd)
    authentication.dispose()
  }, 'desktop-host: authentication channel')
  installOperationDiagnostics(ctx, record => send({ type: 'plugin-operation', record }), 32, runId)
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  if (authorize === undefined) throw new Error('产品认证装配不完整')
  await authorize()
  if (ctx.dshHomePath?.() !== home || ctx.webServer.host !== '127.0.0.1') throw new Error('桌面受保护运行配置无效')
  if (!canPublish()) return
  const admission = ctx.connection.authentication.authenticate({
    headers: { cookie: `dsh-desktop-session=${secret}` },
  })
  if ('rejection' in admission) throw new Error('Desktop authentication provider did not accept its startup credential')
  const url = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}/`
  const injections = ctx.webServer.collectIndexInjections(admission.peer)
  if (!canPublish()) return
  process.send?.({ type: 'ready', generation: input.generation, url, injections }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof HarnessAuthError) {
      process.send?.({ type: 'product-failed', status: error.status, code: error.code, message: error.message },
        () => { if (process.connected) process.disconnect() })
      process.exitCode = 1
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = formatFatalDiagnostic(error)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
