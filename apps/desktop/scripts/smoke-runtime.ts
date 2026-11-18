/** 使用隔离中央服务验证安装资源、账号认证和自定义插件配置。 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { HarnessAuthClient } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import { readHarnessConfig, harnessUserHome } from '@deepseek-ai/dsh-host-harness-product/config'
import { acquireHarnessUserHome } from '@deepseek-ai/dsh-host-harness-product/home'
import { readPrimaryRuntime, workspaceDependencyPaths } from '../../../packages/skill/tool-workspace-dependencies/src/index.ts'
import { DesktopHostProcess } from '../src/host-process.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

const OFFICE_SKILLS = ['office', 'office-docx', 'office-pptx', 'office-xlsx']

/**
 * 确认随包的 Office 指令均可列出并读取正文。
 * @param results - 各指令实际读取的字节数。
 * @throws 缺少任何 Office 指令或正文为空时拒绝验证。
 */
export function assertOfficeSkillsLoadable(results: ReadonlyArray<{ readonly name: string; readonly bytes: number }>): void {
  if (!OFFICE_SKILLS.every(name => results.some(skill => skill.name === name && skill.bytes > 0))) {
    throw new Error(`desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`)
  }
}

/**
 * 验证原生 Office 依赖、中央认证及普通 profile 的扩展装配。
 * @param root - 准备完成或位于 ASAR 内的运行目录。
 * @param node - 目标 Electron 可执行文件。
 * @param runtime - 已核验的目标资源描述。
 * @param environment - 已移除发布凭据的构建环境。
 * @param resourcesRuntime - ASAR 外的解释器与依赖目录。
 * @returns 原生转换、产品 HTTP 认证、扩展装配与退出均已验证。
 */
export async function smokeDesktopRuntime(
  root: string, node: string, runtime: DesktopRuntimeDescriptor, environment: NodeJS.ProcessEnv, resourcesRuntime: string,
): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  const config = readHarnessConfig('dev', fileURLToPath(new URL('../../../config/environments/', import.meta.url)))
  const token = randomBytes(32).toString('base64url')
  const user = { user_id: 'desktop_smoke', login_name: 'desktop_smoke', display_name: '桌面验证账号', status: 'ACTIVE' as const }
  const session = { user, session_id: 'desktop_smoke_session', expires_in: 3600,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(), absolute_expires_at: new Date(Date.now() + 7_200_000).toISOString() }
  const central = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/v1/harness/bootstrap') {
      response.end(JSON.stringify({ deployment_id: config.creativity.deploymentId })); return
    }
    if (request.url === '/api/v1/harness/auth/login' && request.method === 'POST') {
      response.end(JSON.stringify({ ...session, token_type: 'Bearer', access_token: token })); return
    }
    if (request.url === '/api/v1/harness/auth/session' && request.headers.authorization === `Bearer ${token}`) {
      response.end(JSON.stringify(session)); return
    }
    response.writeHead(401); response.end('{}')
  })
  let host: DesktopHostProcess | undefined
  let release: (() => Promise<void>) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      central.once('error', reject)
      central.listen(0, '127.0.0.1', () => { central.removeListener('error', reject); resolve() })
    })
    const address = central.address()
    if (address === null || typeof address === 'string') throw new Error('桌面验证中央端口未分配')
    config.creativity.baseUrl = `http://127.0.0.1:${address.port}`
    config.storage.root = join(scratch, 'dev')
    config.providers.credentials = {}
    config.proxy = { http: null, https: null, noProxy: '*' }
    config.telemetry.enabled = false
    const configuration = join(scratch, 'configuration')
    mkdirSync(configuration)
    writeFileSync(join(configuration, 'dev.json'), JSON.stringify(config))
    const login = await new HarnessAuthClient(config).login({ login_name: user.login_name, password: 'isolated-smoke', captcha_token: 'isolated-smoke' })
    release = await acquireHarnessUserHome(config, login.user.user_id, () => { throw new Error('桌面验证账号目录锁丢失') })
    const home = harnessUserHome(config, login.user.user_id)
    const profile = join(home, 'profiles', 'desktop')
    createPluginProfile(profile)
    const hostEnvironment = { ...environment, DSH_HOME: home, HOME: scratch, USERPROFILE: scratch,
      XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, XDG_STATE_HOME: scratch, APPDATA: scratch, LOCALAPPDATA: scratch }
    const primary = join(resourcesRuntime, 'primary-runtime')
    const dependencies = workspaceDependencyPaths(primary, await readPrimaryRuntime(primary))
    const run = promisify(execFile)
    await run(dependencies.python, ['-I', '-B',
      fileURLToPath(new URL('../tests/fixtures/office-conversion-inputs.py', import.meta.url)), scratch],
    { env: hostEnvironment, timeout: 120_000, windowsHide: true })
    // Office 在单独原生依赖探针中执行，不修改受保护 Host 的插件树。
    const office = await run(node, ['--expose-internals',
      fileURLToPath(new URL('../tests/fixtures/runtime-office-smoke.mjs', import.meta.url)), root, scratch],
    { env: { ...hostEnvironment, ELECTRON_RUN_AS_NODE: '1' }, timeout: 300_000, windowsHide: true })
    const loadedSkills = JSON.parse(office.stdout) as { name: string; bytes: number }[]
    assertOfficeSkillsLoadable(loadedSkills)
    if (!runtime.sharedPackages.some(entry => entry.name === '@deepseek-ai/cordis')) throw new Error('desktop runtime: missing shared Cordis package')
    host = new DesktopHostProcess(node, root, profile, undefined, hostEnvironment, undefined, primary,
      { pnpm: join(primary, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'), nodeBin: join(resourcesRuntime, 'bin') }, undefined,
      { version: 1, generation: 1, environment: 'dev', configDirectory: configuration,
        token: login.access_token, sessionId: login.session_id, user: login.user })
    const ready = await Promise.race([host.start(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('desktop runtime: Host readiness exceeded 120 seconds')) }, 120_000)
    })])
    clearTimeout(timer)
    const anonymous = await fetch(ready.url)
    await anonymous.body?.cancel()
    if (anonymous.status !== 401) throw new Error('desktop runtime: anonymous Host access was not rejected')
    const response = await fetch(ready.url, { headers: { cookie: ready.authenticationCookie } })
    if (response.status !== 200 || !(await response.text()).includes('<html')) throw new Error('desktop runtime: packaged frontend smoke failed')
    await host.stop()
    const pluginDir = join(profile, 'node_modules', 'desktop-extension-fixture')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'desktop-extension-fixture', version: '1.0.0',
      dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(pluginDir, 'cordis.patch.yml'), '[]\n')
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    manifest.dependencies['desktop-extension-fixture'] = 'file:./node_modules/desktop-extension-fixture'
    manifest.dsh.profile.bundles.push('desktop-extension-fixture')
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(profile, 'cordis.patch.yml'), '- id: locale\n  config: { preference: en }\n')
    host = new DesktopHostProcess(node, root, profile, undefined, hostEnvironment, undefined, primary, undefined, undefined,
      { version: 1, generation: 2, environment: 'dev', configDirectory: configuration,
        token: login.access_token, sessionId: login.session_id, user: login.user })
    const extended = await host.start()
    const denied = await fetch(extended.url)
    await denied.body?.cancel()
    if (denied.status !== 401) throw new Error('desktop runtime: custom profile lost anonymous rejection')
    const method = 'pluginManager/listBundles'
    const inventory = await fetch(new URL(`/api/${method}`, extended.url), { method: 'POST',
      headers: { cookie: extended.authenticationCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-plugins', method, payload: { args: {} } }) })
    if (!inventory.ok || !(await inventory.text()).includes('desktop-extension-fixture')) throw new Error('desktop runtime: custom bundle was not loaded')
    console.log('desktop runtime: authenticated Host, custom plugin profile and native Office operations passed')
  } finally {
    clearTimeout(timer)
    try { await host?.stop() }
    finally {
      central.closeAllConnections()
      await new Promise<void>((resolve, reject) => central.close((error) => { if (error !== undefined) reject(error); else resolve() }))
      await release?.()
      await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
    }
  }
}
