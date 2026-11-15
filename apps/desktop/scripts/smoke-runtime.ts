/** 使用隔离中央服务验证安装闭包；产品 Host 保持固定装配与认证。 */
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
 * 验证原生 Office 依赖及经过中央认证的固定产品 Host，不给产品增加测试路由或插件豁免。
 * @param root - 准备完成或位于 ASAR 内的运行目录。
 * @param node - 目标 Electron 可执行文件。
 * @param runtime - 已核验的目标资源描述。
 * @param environment - 已移除发布凭据的构建环境。
 * @param resourcesRuntime - ASAR 外的解释器与依赖目录。
 * @returns 原生转换、产品 HTTP 认证、固定装配与退出均已验证。
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
    // 修改 profile 不能让旧版插件装配绕过当前产品限制。
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['desktop-untrusted-plugin'] = 'file:./untrusted'
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
    host = new DesktopHostProcess(node, root, profile, undefined, hostEnvironment, undefined, primary, undefined, undefined,
      { version: 1, generation: 2, environment: 'dev', configDirectory: configuration,
        token: login.access_token, sessionId: login.session_id, user: login.user })
    try { await host.start() }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes('桌面产品插件配置被修改')) throw error
      console.log('desktop runtime: protected Host, anonymous rejection, fixed composition and native Office operations passed')
      return
    }
    throw new Error('desktop runtime: modified product profile was accepted')
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
