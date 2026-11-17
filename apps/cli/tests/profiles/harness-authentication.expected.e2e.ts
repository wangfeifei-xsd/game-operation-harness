/** 通过实际分发入口验证公开登录、私有插件树和停用后的关闭。 */
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import WebSocket from 'ws'
import { createProcessInspector } from '@deepseek-ai/dsh-subprocess-local/process-inspector'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { parseHarnessConfig } from '../../src/harness-config.ts'
import type { SettingsDescribeValue } from '@deepseek-ai/dsh-settings/types'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
let directory: string
let central: Server
let child: ChildProcess
let origin: string
let cookie: string
let output = ''
let enabled = true
let available = true
let remoteLogout = true
let renewals = 0
let releaseLogin: (() => void) | undefined
let loginReceived: (() => void) | undefined
const children: ChildProcess[] = []
const tokens = new Map<string, { user: string; revoked: boolean; id: string }>()

function session(record: { user: string; id: string }): object {
  return { session_id: record.id, expires_in: 28000,
    expires_at: new Date(Date.now() + 28000_000).toISOString(), absolute_expires_at: new Date(Date.now() + 600000_000).toISOString(),
    user: { user_id: `user_${record.user}`, login_name: record.user, display_name: `User ${record.user}`, status: 'ACTIVE' } }
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('测试端口未分配')
  return address.port
}
async function request(path: string, data?: object, selected = cookie): Promise<Response> {
  return fetch(`${origin}${path}`, { method: data === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { origin, cookie: selected, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) })
}
async function invoke(endpoint: string, args: object): Promise<string> {
  const response = await request(`/api/${endpoint}`, { type: 'client-request', rpcId: randomBytes(8).toString('hex'), method: endpoint, payload: { args } })
  expect(response.status, await response.clone().text()).toBe(200)
  const result = await response.text()
  expect(result).toContain('"ok":true')
  return result
}
async function preferences(): Promise<object> {
  const answer = JSON.parse(await invoke('settings/describe', {})) as { result: { value: SettingsDescribeValue } }
  const entries = new Map(answer.result.value.namespaces.map(row => [row.ns, row]))
  return {
    writable: answer.result.value.writable,
    theme: entries.get('ui-theme')?.value,
    language: entries.get('locale')?.value,
    chat: entries.get('ui-chat')?.value,
    conversation: entries.get('ui-conversation')?.value,
    codeWorkView: entries.get('ui-settings')?.value,
    permissionWritable: entries.get('permission')?.writable,
  }
}
async function launch(cli: string): Promise<ChildProcess> {
  const process = spawn(globalThis.process.execPath, [join(cli, 'lib/bin.js'), '--profile', 'harness', '--environment', 'dev', '--no-open'], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...globalThis.process.env, DSH_HOME: '/must-not-be-used', DEEPSEEK_BASE_URL: 'https://invalid.example' },
  })
  children.push(process)
  let text = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(text || '入口启动超时')) }, 20_000)
    const append = (bytes: Buffer): void => {
      text += String(bytes); output += String(bytes)
      if (text.includes('Harness:')) { clearTimeout(timer); resolve() }
    }
    process.stdout?.on('data', append); process.stderr?.on('data', append)
    process.once('error', reject)
    process.once('exit', () => { clearTimeout(timer); reject(new Error(text || '入口启动失败')) })
  })
  return process
}
async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  const force = setTimeout(() => { process.kill('SIGKILL') }, 10_000)
  process.kill('SIGTERM')
  await exited
  clearTimeout(force)
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'harness-auth-'))
  central = createServer((request, response) => {
    void (async () => {
      response.setHeader('content-type', 'application/json')
      const reply = (status: number, value: object): void => { response.writeHead(status); response.end(JSON.stringify(value)) }
      if (!available) { reply(503, { error: { code: 'UNAVAILABLE', message: '认证服务暂不可用' } }); return }
      if (request.url?.endsWith('/bootstrap')) { reply(200, { deployment_id: 'harness-dev', registration_enabled: true, password_min_length: 12, password_max_length: 256 }); return }
      if (request.url?.endsWith('/auth/login')) {
        const chunks: Buffer[] = []
        for await (const chunk of request) {
          const value: unknown = chunk
          if (typeof value === 'string') chunks.push(Buffer.from(value))
          else if (value instanceof Uint8Array) chunks.push(Buffer.from(value))
          else throw new Error('测试请求正文无效')
        }
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
        if (typeof value !== 'object' || value === null || !('login_name' in value) || typeof value.login_name !== 'string') {
          throw new Error('测试登录名无效')
        }
        if (value.login_name === 'late') { loginReceived?.(); await new Promise<void>((resolve) => { releaseLogin = resolve }) }
        const token = randomBytes(32).toString('base64url')
        const record = { user: value.login_name, id: `session_${tokens.size}`, revoked: false }
        tokens.set(token, record)
        reply(200, { ...session(record), token_type: 'Bearer', access_token: token }); return
      }
      const record = tokens.get(request.headers.authorization?.slice(7) ?? '')
      if (request.url?.endsWith('/auth/logout')) {
        if (!remoteLogout) { reply(503, { error: { code: 'UNAVAILABLE', message: '认证服务暂不可用' } }); return }
        if (record) record.revoked = true
        response.writeHead(204); response.end(); return
      }
      if (!record || record.revoked || !enabled) { reply(403, { error: { code: 'HARNESS_USER_DISABLED', message: '账号已停用，请联系管理员' } }); return }
      if (request.url?.endsWith('/auth/renew')) renewals += 1
      reply(200, session(record))
    })().catch(() => { response.destroy() })
  })
  const centralPort = await listen(central)
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => { resolve() }))
  origin = `http://127.0.0.1:${port}`
  const cli = join(directory, 'apps/cli')
  await mkdir(cli, { recursive: true })
  await cp(join(repository, 'apps/cli/lib'), join(cli, 'lib'), { recursive: true })
  await cp(join(repository, 'apps/cli/package.json'), join(cli, 'package.json'))
  await symlink(join(repository, 'apps/cli/node_modules'), join(cli, 'node_modules'), 'junction')
  const config = parseHarnessConfig(JSON.parse(await readFile(join(repository, 'config/environments/dev.json'), 'utf8')), 'dev')
  config.server.port = port
  config.creativity.baseUrl = `http://127.0.0.1:${centralPort}`
  config.storage.root = join(directory, 'data/dev')
  const legacyHome = join(config.storage.root, 'users/channel_harness/user_alpha')
  await mkdir(legacyHome, { recursive: true })
  await writeFile(join(legacyHome, 'upgrade-marker'), '原有账号数据')
  config.auth.heartbeatIntervalMs = 250
  config.auth.shutdownGraceMs = 1500
  await writeFile(join(cli, 'lib/resources/environments/dev.json'), JSON.stringify(config))
  await writeFile(join(directory, '.env'), 'DSH_HOME=/must-not-be-used\nDSH_PERMISSION_MODE=invalid\n')
  child = await launch(cli)
  const response = await request('/harness/api/session', undefined, '')
  cookie = response.headers.get('set-cookie')!.split(';')[0]!
  expect(cookie).toMatch(/^harness_dev_\d+=/u)
}, 30_000)

afterAll(async () => {
  releaseLogin?.()
  await Promise.all(children.map(stop))
  central?.closeAllConnections()
  if (central) await new Promise<void>(resolve => central.close(() => { resolve() }))
  if (directory) await rm(directory, { recursive: true, force: true })
})

it('serves the authenticated product tree and stops every old identity before switching users', async () => {
  expect((await request('/api/anything', undefined, '')).status).toBe(401)
  const denied = await fetch(`${origin}/harness/api/session`, { headers: { origin: 'http://untrusted.example' } })
  expect(denied.status).toBe(403)
  const login = await request('/harness/api/login', { login_name: 'alpha' })
  expect(await login.text(), output).toContain('"authenticated":true')
  expect(await readFile(join(directory, 'data/dev/users/user_alpha/upgrade-marker'), 'utf8')).toBe('原有账号数据')
  await expect(readFile(join(directory, 'data/dev/users/channel_harness/user_alpha/upgrade-marker'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await request('/harness/api/session')).status).toBe(200)
  expect((await request('/harness/api/session', undefined, '')).status).toBe(409)
  const html = await request('/')
  const page = await html.text()
  expect(html.status, output).toBe(200)
  expect(page.includes('<meta name="agent-assistant-account" content="enabled">')).toBe(true)
  for (const token of tokens.keys()) expect(page).not.toContain(token)
  expect(page).not.toContain('x-harness-parent-secret')
  expect(html.headers.get('cache-control')).toBe('no-store')
  expect(page).not.toMatch(/http:\/\/127\.0\.0\.1:\d+/u)
  await invoke('settings/update', { ns: 'ui-theme', patch: { preference: 'light', fontSize: 18 } })
  await invoke('settings/update', { ns: 'locale', patch: { preference: 'en' } })
  await invoke('settings/update', { ns: 'ui-chat', patch: { collapseTiming: 'next-input', foldedReplies: 'final' } })
  await invoke('settings/update', { ns: 'ui-conversation', patch: { busyEnter: 'steer' } })
  await invoke('settings/update', { ns: 'ui-settings', patch: { enabled: false } })
  const expectedPreferences: unknown = JSON.parse(await readFile(new URL('./expected/harness-authentication/preferences.expected.json', import.meta.url), 'utf8'))
  expect(await preferences()).toEqual(expectedPreferences)
  expect(JSON.parse(await readFile(join(directory, 'data/dev/users/user_alpha/preferences.json'), 'utf8')))
    .toMatchObject({ 'ui-theme': { preference: 'light', fontSize: 18 } })
  const protectedSettings = await request('/api/settings/update', {
    type: 'client-request', rpcId: 'protected-settings', method: 'settings/update',
    payload: { args: { ns: 'permission', patch: { defaultPreset: 'full-access' } } },
  })
  expect(await protectedSettings.text()).toContain('settings/rejected')
  expect(await invoke('modelConfig/list', {})).toContain('"models":[]')
  const oldAccount = await request('/api/account/getState', {
    type: 'client-request', rpcId: 'removed-account', method: 'account/getState', payload: { args: {} },
  })
  expect(await oldAccount.text()).not.toContain('"ok":true')
  await invoke('modelConfig/save', { input: {
    name: '隔离模型', providerKey: 'other', protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'alpha-model-key', model: 'fixture-model',
    contextWindow: 8192, maxOutputTokens: 1024, timeoutSeconds: 60, imageInput: false,
  }, expectedRevision: 0 })
  expect(await invoke('modelConfig/list', {})).not.toContain('alpha-model-key')
  expect(await invoke('credentials/set', { ref: 'HARNESS_FIXTURE', value: 'alpha-only-secret' })).toContain('"ok":true')
  expect(await invoke('credentials/describe', { refs: ['HARNESS_FIXTURE'] })).toContain('"configured":true')
  const created = await invoke('session/create', { request: { sessionId: 'harness_fixture_alpha', cwd: directory } })
  expect(created).toContain('harness_fixture_alpha')
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/remote.mux`, { headers: { origin, cookie } })
  socket.on('error', () => { /* 停用关闭连接属于测试预期，最终检查关闭状态。 */ })
  await once(socket, 'open')
  await expect.poll(() => renewals).toBe(0)
  expect((await request('/harness/api/renew', {})).status).toBe(200)
  expect(renewals).toBe(1)
  enabled = false
  socket.send(JSON.stringify({ type: 'open', streamId: 'after-disable', endpoint: 'session/observeState', payload: { args: { request: { sessionId: 'harness_fixture_alpha' } } } }))
  await expect.poll(async () => (await request('/harness/api/session')).text(), { timeout: 10_000 }).toContain('"state":"unavailable"')
  await expect.poll(() => socket.readyState).toBe(WebSocket.CLOSED)
  expect((await request('/api/anything')).status).toBe(403)
  enabled = true
  const second = await request('/harness/api/login', { login_name: 'beta' })
  expect(second.status, await second.text()).toBe(200)
  expect(await invoke('credentials/describe', { refs: ['HARNESS_FIXTURE'] })).toContain('"configured":false')
  expect(await invoke('session/list', { _request: {} })).not.toContain('harness_fixture_alpha')
  expect(await invoke('modelConfig/list', {})).toContain('"models":[]')
  expect(await preferences()).toMatchObject({ theme: { preference: 'system', fontSize: 14 } })
  expect((await readFile(join(directory, 'data/dev/users/user_alpha/profiles/harness-runtime/package.json'), 'utf8'))).toContain('dsh-web-app')
  expect((await readFile(join(directory, 'data/dev/users/user_beta/profiles/harness-runtime/package.json'), 'utf8'))).toContain('dsh-web-app')
  remoteLogout = false
  const logout = await request('/harness/api/logout', {})
  expect(logout.status).toBe(503)
  expect(await logout.text()).toContain('本机已退出，远端退出未确认')
  expect((await request('/api/anything')).status).toBe(401)
  remoteLogout = true
  const received = new Promise<void>((resolve) => { loginReceived = resolve })
  const late = request('/harness/api/login', { login_name: 'late' })
  await received
  expect((await request('/harness/api/logout', {})).status).toBe(200)
  releaseLogin!()
  expect((await late).status).toBe(401)
  expect(await (await request('/harness/api/session')).json()).toMatchObject({ authenticated: false })
  expect([...tokens.values()].find(record => record.user === 'late')?.revoked).toBe(true)
  expect((await request('/harness/api/login', { login_name: 'alpha' })).status).toBe(200)
  expect(await invoke('credentials/describe', { refs: ['HARNESS_FIXTURE'] })).toContain('"configured":true')
  expect(await invoke('session/list', { _request: {} })).toContain('harness_fixture_alpha')
  expect(await invoke('modelConfig/list', {})).toContain('隔离模型')
  await expect.poll(preferences).toEqual(expectedPreferences)
  available = false
  const unavailable = await request('/harness/api/renew', {})
  expect(unavailable.status).toBe(503)
  expect(await unavailable.text()).toContain('认证服务暂不可用')
  available = true
  await expect.poll(async () => (await request('/harness/api/session')).text()).toContain('"state":"unavailable"')
}, 90_000)

it('keeps one writer per account and stops its private Host after the parent is killed', async () => {
  expect((await request('/harness/api/login', { login_name: 'alpha' })).status).toBe(200)
  const inspector = createProcessInspector()
  const owned = inspector.snapshot().tree(child.pid!)
  expect(owned.length).toBeGreaterThan(1)
  const cli = join(directory, 'second/apps/cli')
  await mkdir(cli, { recursive: true })
  await cp(join(directory, 'apps/cli/lib'), join(cli, 'lib'), { recursive: true })
  await cp(join(repository, 'apps/cli/package.json'), join(cli, 'package.json'))
  await symlink(join(repository, 'apps/cli/node_modules'), join(cli, 'node_modules'), 'junction')
  const config = parseHarnessConfig(JSON.parse(await readFile(join(cli, 'lib/resources/environments/dev.json'), 'utf8')), 'dev')
  const reservation = createServer()
  config.server.port = await listen(reservation)
  await new Promise<void>(resolve => reservation.close(() => { resolve() }))
  await writeFile(join(cli, 'lib/resources/environments/dev.json'), JSON.stringify(config))
  await launch(cli)
  const firstOrigin = origin
  origin = `http://127.0.0.1:${config.server.port}`
  cookie = (await request('/harness/api/session', undefined, '')).headers.get('set-cookie')!.split(';')[0]!
  const duplicate = await request('/harness/api/login', { login_name: 'alpha' })
  expect(duplicate.status).toBe(409)
  expect(await duplicate.text()).toContain('HARNESS_HOME_IN_USE')
  expect((await fetch(`${firstOrigin}/harness/login`)).status).toBe(200)
  child.kill('SIGKILL')
  await expect.poll(() => {
    const snapshot = inspector.snapshot()
    return owned.some(identity => snapshot.alive(identity))
  }, { timeout: 10_000 }).toBe(false)
  // 目录锁由文件心跳判旧；父进程崩溃后必须等待旧锁失效，不能抢占有效锁。
  await expect.poll(async () => (await request('/harness/api/login', { login_name: 'alpha' })).status, { timeout: 25_000, interval: 1000 }).toBe(200)
  expect(await invoke('session/list', { _request: {} })).toContain('harness_fixture_alpha')
}, 45_000)
