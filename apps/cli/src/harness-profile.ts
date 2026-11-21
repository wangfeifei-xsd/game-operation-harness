/** 产品登录与账号运行 profiles；身份来自环境文件，扩展使用账号配置。 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Command } from 'commander'
import { initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { installProxyFromConfig } from '@deepseek-ai/dsh-http-proxy'
import { HarnessAuthClient, HarnessAuthError } from './harness-auth-client.ts'
import { readHarnessConfig, harnessUserHome } from './harness-config.ts'
import { harnessComposition, harnessDefaults } from './harness-composition.ts'
import { installHarnessPrivateAuth } from './harness-private-auth.ts'
import { harnessEntry } from './harness-entry.ts'
import { businessAssistant } from './harness-embed-runtime.ts'
import { runProfile, INSTALL_ANCHOR } from './profile-boot.ts'
import type { HarnessStart } from './harness-runtime-process.ts'

async function receiveStart(): Promise<HarnessStart> {
  if (process.send === undefined || !process.connected || process.ppid <= 1) throw new HarnessAuthError(403, 'HARNESS_PRIVATE_ONLY', '私有运行入口必须由登录协调器启动')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() =>{  finish(new HarnessAuthError(403, 'HARNESS_PRIVATE_ONLY', '私有启动身份未收到')) }, 10_000)
    const finish = (result: Error | HarnessStart): void => {
      clearTimeout(timer); process.off('message', receive); process.off('disconnect', disconnected)
      if (result instanceof Error) reject(result); else resolve(result)
    }
    const disconnected = (): void => { finish(new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '父进程已退出')) }
    const receive = (value: unknown): void => {
      if (typeof value !== 'object' || value === null || !('kind' in value) || value.kind !== 'harness/start'
        || !('generation' in value) || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation)
        || !('sessionId' in value) || typeof value.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.sessionId)
        || !('token' in value) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)
        || !('secret' in value) || typeof value.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.secret)
        || !('user' in value) || typeof value.user !== 'object' || value.user === null
        || !('user_id' in value.user) || typeof value.user.user_id !== 'string'
        || !('login_name' in value.user) || typeof value.user.login_name !== 'string'
        || !('display_name' in value.user) || typeof value.user.display_name !== 'string'
        || !('status' in value.user) || value.user.status !== 'ACTIVE') { finish(new HarnessAuthError(403, 'HARNESS_PRIVATE_ONLY', '私有启动身份无效')); return }
      finish({ kind: 'harness/start', generation: value.generation, sessionId: value.sessionId, token: value.token, secret: value.secret,
        user: { user_id: value.user.user_id, login_name: value.user.login_name, display_name: value.user.display_name, status: 'ACTIVE' } })
    }
    process.on('message', receive); process.once('disconnect', disconnected)
  })
}

/**
 * 显式选择登录环境，将用户覆盖补丁传给认证后的账号运行树。
 * @param profile - 公开入口或私有运行 profile。
 * @param args - 此 profile 的命令行参数。
 * @param patchFiles - 命令行覆盖文件；省略时只读取账号配置。
 * @returns 产品树启动完成。
 */
export async function runHarnessProfile(profile: 'harness' | 'harness-runtime', args: readonly string[], patchFiles: readonly string[] = []): Promise<void> {
  const command = new Command(`dsh --profile ${profile}`).requiredOption('--environment <name>', 'dev、test、fat 或 master').option('--no-open', '不自动打开浏览器')
  command.parse([...args], { from: 'user' })
  const flags = command.opts<{ environment: string; open: boolean }>()
  const config = readHarnessConfig(flags.environment)
  const extensionEnvironment = { ...process.env }
  const disposeProxy = await installProxyFromConfig(config.proxy)
  const input = profile === 'harness-runtime' ? await receiveStart() : undefined
  let stopped = false
  const isStopped = (): boolean => stopped
  let shutdown: (() => void) | undefined
  const stop = (error?: HarnessAuthError): void => {
    if (stopped) return
    stopped = true
    process.send?.({ kind: 'harness/failed', generation: input?.generation,
      ...(error === undefined ? {} : { error: { status: error.status, code: error.code, message: error.message } }),
    }, () => {})
    shutdown?.()
    // 启动尚未完成时也有停止上限，进程 exit 钩子继续终止受管命令。
    setTimeout(() => { process.exit(1) }, config.auth.shutdownGraceMs).unref()
  }
  const disconnect = (): void => { stop() }
  const onMessage = (message: unknown): void => {
    if (typeof message === 'object' && message !== null && 'kind' in message) {
      if (message.kind === 'harness/stop' || message.kind === 'harness/start') stop()
    }
  }
  if (input !== undefined) { process.on('disconnect', disconnect); process.on('message', onMessage) }
  const home = input === undefined ? join(config.storage.root, 'entry') : harnessUserHome(config, input.user.user_id)
  const dir = join(home, 'profiles', profile)
  const bundles = input === undefined ? [] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  initProfile(dir, bundles)
  const resolved = loadProfileDirectory('dsh', dir, INSTALL_ANCHOR, { userLayer: input !== undefined })
  try {
    const client = new HarnessAuthClient(config)
    if (input !== undefined) {
      await client.bootstrap()
      const session = await client.session(input.token)
      if (session.user.user_id !== input.user.user_id || session.session_id !== input.sessionId || isStopped()) throw new HarnessAuthError(401, 'HARNESS_RUNTIME_CLOSED', '启动身份已经失效')
    }
    const authorization: { run?: () => Promise<void> } = {}
    const runtime = await runProfile({ profile, resolvedProfile: { profile: resolved, installAnchor: INSTALL_ANCHOR },
      patchFiles: input === undefined ? [] : patchFiles, args: [],
      product: {
        home, patches: [], defaults: patches => harnessDefaults(patches, config, extensionEnvironment),
        transform: patches => input === undefined ? [] : harnessComposition(patches, config, home),
        prepare: async (ctx) => {
          ctx.provide('fileDeployment', true)
          ctx.provide('fileDeploymentHome', home)
          ctx.effect(() => disposeProxy)
          if (input === undefined) {
            const assistant = businessAssistant({ config, home, installAnchor: INSTALL_ANCHOR, environment: extensionEnvironment })
            ctx.effect(() => () => assistant.close())
            await ctx.plugin(harnessEntry, {
              config, assistant, openBrowser: flags.open, patchFiles: patchFiles.map(file => resolve(file)),
            })
            return
          }
          ctx.provide('webStartup', { host: '127.0.0.1', port: 0, openBrowser: false, trustedHosts: [] })
          authorization.run = installHarnessPrivateAuth(ctx, config, input, stop)
        },
      },
    })
    shutdown = () => { runtime.shutdown.interrupt(0) }
    if (isStopped()) { shutdown(); return }
    if (input !== undefined) {
      if (authorization.run === undefined) throw new HarnessAuthError(503, 'HARNESS_COMPOSITION_INVALID', '运行服务装配不完整')
      await authorization.run()
      if (runtime.ctx.get('webServer') === undefined || runtime.ctx.get('connection.authentication') === undefined || runtime.ctx.dshHomePath?.() !== home) throw new HarnessAuthError(503, 'HARNESS_COMPOSITION_INVALID', '运行服务装配不完整')
      process.send?.({ kind: 'harness/ready', generation: input.generation, origin: runtime.ctx.webServer.getOrigin() }, (error) => { if (error !== null) stop() })
    }
  } catch (error) {
    if (input !== undefined) stop()
    await disposeProxy()
    throw error
  }
}
