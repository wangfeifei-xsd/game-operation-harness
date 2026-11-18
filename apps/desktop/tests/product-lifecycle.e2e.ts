/** 真实 Electron 与受保护 Host 的账号隔离、停止和重启；中央网络使用独立服务桩。 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { acquireHarnessUserHome } from '@deepseek-ai/dsh-host-harness-product/home'
import type { ModelConfigSnapshot } from '@deepseek-ai/dsh-harness-model-config/types'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { HarnessProductFixture, HARNESS_REPOSITORY, productRemote } from '../../web/tests/harness-product-fixture.ts'

const fixture = new HarnessProductFixture()
const require = createRequire(import.meta.url)
const electron = require('electron') as string
const artifact = join(HARNESS_REPOSITORY, '.local/electron-remediation/lifecycle')
let application: ElectronApplication | undefined
let proxy: Server
let appDirectory: string
let runtimeDirectory: string
let centralStatus = 200
let output = ''
const tokens = new Set<string>()

async function account<T>(page: Page, operation: string, body?: object): Promise<T> {
  const reply = await page.evaluate(async ({ operation, body }) => {
    const transport = Reflect.get(window, 'agentAssistantAccount') as {
      request(operation: string, body?: object): Promise<{ ok: boolean; value?: unknown; error?: unknown }>
    }
    return transport.request(operation, body)
  }, { operation, body })
  expect(reply.ok, JSON.stringify(reply.error)).toBe(true)
  return reply.value as T
}
async function authPage(): Promise<Page> {
  await expect.poll(() => application?.windows().some(page => page.url() === 'dsh-app://auth/'), { timeout: 30_000 }).toBe(true)
  const page = application!.windows().find(page => page.url() === 'dsh-app://auth/')!
  await page.waitForFunction(() => Reflect.get(window, 'agentAssistantAccount') !== undefined)
  return page
}
function hostPids(): number[] {
  return execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .filter(line => line.includes(join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js')))
    .map(line => Number(line.trim().split(/\s+/u)[0]))
}
async function start(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP_DSH_DIR: runtimeDirectory,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(HARNESS_REPOSITORY, 'apps/desktop/.desktop-build/targets/mac-arm64/runtime/primary-runtime'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_HOME: join(fixture.directory, 'ignored-upstream-home'),
    DSH_AGENTS_HOME: join(fixture.directory, 'personal-agents'), DSH_PRODUCT_ANALYTICS_OTLP_URL: fixture.config.telemetry.url,
  }
  delete env.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: electron,
    args: [appDirectory, '--environment', 'dev', '--lang=zh-CN'], cwd: fixture.directory,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)), timeout: 30_000 })
  application.process().stdout?.on('data', (bytes: Buffer) => { output += bytes.toString() })
  application.process().stderr?.on('data', (bytes: Buffer) => { output += bytes.toString() })
  expect(await account(await authPage(), 'session')).toMatchObject({ state: 'signedOut', authenticated: false })
  expect(hostPids()).toEqual([])
}
async function login(user: string): Promise<Page> {
  await account(await authPage(), 'login', { login_name: user, password: 'fixture-password', captcha_token: 'fixture-proof' })
  await expect.poll(() => application?.windows().some(page => page.url() === 'dsh-app://app/'), { timeout: 45_000 }).toBe(true)
  const page = application!.windows().find(page => page.url() === 'dsh-app://app/')!
  await page.getByRole('button', { name: /^(模型配置|Model configuration)$/u }).waitFor({ timeout: 30_000 })
  expect(await account(page, 'session')).toMatchObject({ state: 'active', user: { login_name: user } })
  await expect.poll(() => hostPids()).toHaveLength(1)
  return page
}
async function signOut(page: Page): Promise<void> {
  const closed = page.waitForEvent('close')
  await account(page, 'logout').catch((error: unknown) => { if (!page.isClosed()) throw error })
  await closed
  await expect.poll(async () => (await account<{ state: string }>(await authPage(), 'session')).state,
    { timeout: 15_000 }).toBe('signedOut')
  await expect.poll(hostPids).toEqual([])
}
async function stop(): Promise<void> {
  const app = application
  if (app === undefined) return
  const workspace = app.windows().find(page => page.url() === 'dsh-app://app/')
  if (workspace !== undefined) await signOut(workspace)
  await app.close(); application = undefined
}
async function models(page: Page): Promise<ModelConfigSnapshot> {
  const result = await productRemote<ModelConfigSnapshot>(page, 'modelConfig/list', {})
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

beforeAll(async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return
  await fixture.initialize(); await mkdir(artifact, { recursive: true })
  const upstream = fixture.config.creativity.baseUrl
  proxy = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      if (centralStatus !== 200) {
        response.writeHead(centralStatus, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: centralStatus === 403 ? 'HARNESS_USER_DISABLED' : 'HARNESS_AUTH_UNAVAILABLE', message: '认证不可用' })); return
      }
      const reply = await fetch(new URL(request.url ?? '/', upstream), { method: request.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }) },
        ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }) })
      const content = await reply.text()
      if (request.url?.endsWith('/auth/login') && reply.ok) {
        const parsed = JSON.parse(content) as { access_token: string }; tokens.add(parsed.access_token)
      }
      response.writeHead(reply.status, { 'content-type': 'application/json' }); response.end(content)
    })().catch(() => { response.destroy() })
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address()
  if (typeof address !== 'object' || address === null) throw new Error('中央代理端口未分配')
  fixture.config.creativity.baseUrl = `http://127.0.0.1:${address.port}`
  await writeFile(join(fixture.directory, 'config/environments/dev.json'), JSON.stringify(fixture.config))
  appDirectory = join(fixture.directory, 'apps/desktop')
  await mkdir(appDirectory, { recursive: true })
  for (const part of ['lib', 'renderer', 'resources', 'scripts/node-bin']) {
    await cp(join(HARNESS_REPOSITORY, 'apps/desktop', part), join(appDirectory, part), { recursive: true })
  }
  await cp(join(HARNESS_REPOSITORY, 'apps/desktop/package.json'), join(appDirectory, 'package.json'))
  await symlink(join(HARNESS_REPOSITORY, 'apps/desktop/node_modules'), join(appDirectory, 'node_modules'), 'junction')
  runtimeDirectory = join(fixture.directory, 'runtime-project')
  prepareDevelopmentProject({ projectDir: runtimeDirectory, cliDir: join(HARNESS_REPOSITORY, 'apps/cli'),
    hostDir: join(HARNESS_REPOSITORY, 'apps/desktop-host'), dependencyDir: join(HARNESS_REPOSITORY, 'node_modules/.pnpm/node_modules'),
    target: 'mac-arm64', release: { schemaVersion: 1, version: '0.2.2-rc.3', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion: execFileSync(electron, ['-p', 'process.versions.node'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim(),
      pnpmVersion: (require('pnpm') as { version: string }).version },
  })
}, 60_000)
afterAll(async () => {
  centralStatus = 200
  await application?.close(); application = undefined
  if (proxy !== undefined) { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => { resolve() })) }
  await fixture.close()
}, 60_000)

it.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')('isolates real account windows and stops its Host on central denial and failure', { timeout: 180_000, retry: 0 }, async () => {
  onTestFailed(async () => {
    await writeFile(join(artifact, 'main.log'), output)
    const page = application?.windows().find(window => !window.isClosed())
    if (page !== undefined) await page.screenshot({ path: join(artifact, 'failure.png') })
  })
  await start()
  await (await authPage()).screenshot({ path: join(artifact, 'signed-out.png') })
  const alpha = await login('alpha')
  await expect(acquireHarnessUserHome(fixture.config, 'user_alpha', () => {})).rejects.toMatchObject({ code: 'HARNESS_HOME_IN_USE' })
  const saved = await productRemote<ModelConfigSnapshot>(alpha, 'modelConfig/save', {
    input: { name: '账号甲的模型', providerKey: 'other', protocol: 'openai-completions', baseUrl: fixture.providerUrl,
      model: 'fixture-model', apiKey: 'alpha-only-key', timeoutSeconds: 30, imageInput: false,
      contextWindow: 32_000, maxOutputTokens: 1_000 }, expectedRevision: 0,
  })
  expect(saved.ok, JSON.stringify(saved)).toBe(true)
  await alpha.evaluate(() => { localStorage.setItem('account-private-marker', 'alpha') })
  const pid = hostPids()[0]!
  const listen = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' })
  const port = /127\.0\.0\.1:(\d+)\s+\(LISTEN\)/u.exec(listen)?.[1]
  expect(port).toBeDefined()
  expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(401)
  await signOut(alpha)
  const release = await acquireHarnessUserHome(fixture.config, 'user_alpha', () => {}); await release()
  const beta = await login('beta')
  expect(await beta.evaluate(() => localStorage.getItem('account-private-marker'))).toBeNull()
  expect((await models(beta)).models).toEqual([])
  await signOut(beta)
  const restored = await login('alpha')
  const restoredModels = await models(restored)
  expect(restoredModels.models).toHaveLength(1)
  expect(restoredModels.models[0]).toMatchObject({ name: '账号甲的模型', credentialConfigured: true })
  expect((await productRemote(restored, 'modelConfig/testConnection', {
    request: { id: restoredModels.models[0]!.id, expectedRevision: restoredModels.revision },
  })).ok).toBe(true)
  expect(fixture.calls.at(-1)?.key).toBe('Bearer alpha-only-key')
  expect(await restored.evaluate(() => localStorage.getItem('account-private-marker'))).toBeNull()
  const publicState = JSON.stringify(await account(restored, 'session'))
  for (const token of tokens) { expect(publicState).not.toContain(token); expect(output).not.toContain(token) }
  expect(await restored.getByRole('button', { name: /下载桌面版|Download desktop app/u }).count()).toBe(0)
  const stoppedAt = performance.now(); centralStatus = 403
  await expect.poll(async () => (await account<{ state: string }>(await authPage(), 'session')).state,
    { timeout: 20_000 }).toBe('unavailable')
  await expect.poll(hostPids).toEqual([])
  const disabledStopMs = Math.round(performance.now() - stoppedAt)
  expect(disabledStopMs).toBeLessThanOrEqual(20_000)
  centralStatus = 200
  expect(await account(await authPage(), 'session')).toMatchObject({ authenticated: false })
  await login('beta')
  centralStatus = 503
  await expect.poll(async () => (await account<{ state: string }>(await authPage(), 'session')).state,
    { timeout: 20_000 }).toBe('unavailable')
  await expect.poll(hostPids).toEqual([])
  centralStatus = 200
  await stop(); await start()
  expect(await account(await authPage(), 'session')).toMatchObject({ state: 'signedOut' })
  await stop()
  await writeFile(join(artifact, 'result.json'), JSON.stringify({ platform: process.platform, architecture: process.arch,
    disabledStopMs, accountSwitches: 3, restartedSignedOut: true, central: 'isolated-http-fixture' }))
})
