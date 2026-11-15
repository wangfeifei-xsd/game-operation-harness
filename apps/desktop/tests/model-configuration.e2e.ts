/** 真实 Electron 主进程、preload 与 Desktop Host 的模型配置和完整退出重启。 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { _electron, type ElectronApplication, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import type { ModelConfigSnapshot } from '@deepseek-ai/dsh-harness-model-config/types'
import { prepareDevelopmentProject } from '../scripts/development-project.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { HarnessProductFixture, HARNESS_REPOSITORY, productRemote } from '../../web/tests/harness-product-fixture.ts'
import { writeComposerDraft } from '../../web/tests/support.ts'

const fixture = new HarnessProductFixture()
const require = createRequire(import.meta.url)
const electron = require('electron') as string
const preparedRuntime = process.env.DSH_MODEL_CONFIG_DESKTOP_RUNTIME
const desktopTarget = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
const artifact = join(HARNESS_REPOSITORY, preparedRuntime === undefined
  ? '.artifacts/harness-model-desktop' : '.artifacts/harness-model-desktop-production')
let application: ElectronApplication | undefined
let page: Page
let appDirectory: string
let runtimeDirectory: string
const consoleErrors: string[] = []
let mainOutput = ''

async function start(): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env, DSH_DESKTOP_DSH_DIR: runtimeDirectory,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR: join(HARNESS_REPOSITORY, 'apps/desktop/.desktop-build/targets', desktopTarget, 'runtime/primary-runtime'),
    DSH_DESKTOP_OPEN_DEVTOOLS: '0', DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS: '5000',
  }
  delete environment.ELECTRON_RUN_AS_NODE
  application = await _electron.launch({ executablePath: electron,
    args: [appDirectory, '--environment', 'dev', '--lang=zh-CN'], cwd: appDirectory, env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)), timeout: 30_000 })
  application.process().stdout?.on('data', (bytes: Buffer) => { mainOutput += bytes.toString() })
  application.process().stderr?.on('data', (bytes: Buffer) => { mainOutput += bytes.toString() })
  await expect.poll(() => application?.windows().some(window => window.url() === 'dsh-app://auth/'), { timeout: 30_000 }).toBe(true)
  const auth = application.windows().find(window => window.url() === 'dsh-app://auth/')!
  await auth.waitForFunction(() => Reflect.get(window, 'agentAssistantAccount') !== undefined)
  const result = await auth.evaluate(async () => {
    const account = Reflect.get(window, 'agentAssistantAccount') as { request(operation: string, body?: object): Promise<{ ok: boolean; error?: object }> }
    return account.request('login', { login_name: 'alpha', password: 'fixture-password', captcha_token: 'fixture-proof' })
  })
  expect(result.ok, JSON.stringify(result)).toBe(true)
  await expect.poll(() => application?.windows().some(window => window.url().startsWith('dsh-app://app/')), { timeout: 45_000 }).toBe(true)
  page = application.windows().find(window => window.url().startsWith('dsh-app://app/'))!
  page.on('pageerror', (error) => { consoleErrors.push(error.message) })
  await page.getByRole('button', { name: /^(模型配置|Model configuration)$/u }).waitFor({ timeout: 30_000 })
}
async function stop(): Promise<void> {
  if (application === undefined) return
  const owned = application
  const workspace = owned.windows().find(window => window.url().startsWith('dsh-app://app/'))
  if (workspace !== undefined && !workspace.isClosed()) {
    const closed = workspace.waitForEvent('close', { timeout: 30_000 })
    const result = await workspace.evaluate(async () => {
      const account = Reflect.get(window, 'agentAssistantAccount') as { request(operation: string): Promise<{ ok: boolean }> }
      return account.request('logout')
    }).catch((error: unknown) => {
      // 注销会销毁工作区，关闭后以认证窗口重新出现确认操作完成。
      if (!workspace.isClosed()) throw error
    })
    if (result !== undefined) expect(result.ok).toBe(true)
    await closed
    const auth = owned.windows().find(window => window.url() === 'dsh-app://auth/')
    if (auth === undefined) throw new Error('注销后认证窗口不存在')
    await auth.waitForFunction(async () => {
      const account = Reflect.get(window, 'agentAssistantAccount') as {
        request(operation: string): Promise<{ ok: boolean; value?: { state: string } }>
      }
      const reply = await account.request('session')
      return reply.ok && reply.value?.state === 'signedOut'
    }, undefined, { timeout: 30_000 })
  }
  await owned.close()
  application = undefined
}
async function models(): Promise<ModelConfigSnapshot> {
  const result = await productRemote<ModelConfigSnapshot>(page, 'modelConfig/list', {})
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function open(): Promise<void> {
  await page.getByRole('button', { name: /^(模型配置|Model configuration)$/u }).click()
  await page.getByRole('heading', { name: /^(模型配置|Model configuration)$/u }).waitFor()
}
async function add(): Promise<void> {
  await page.getByRole('button', { name: /^(新增模型|Add model)$/u }).first().click()
  const dialog = page.getByRole('dialog', { name: /^(新增模型|Add model)$/u })
  await dialog.getByLabel(/^(模型名称|Model name)$/u).fill('桌面模型')
  await dialog.getByLabel(/^(供应商|Provider)$/u).click()
  await page.getByRole('option', { name: '其他', exact: true }).click()
  await dialog.getByLabel(/^(接口地址|API base URL)$/u).fill(fixture.providerUrl)
  await dialog.getByLabel(/^(API Key|API key)$/u).fill('desktop-key-first')
  await dialog.getByLabel(/^(模型标识|Model identifier)$/u).fill('fixture-model')
  await dialog.getByLabel(/^(上下文上限（Token）|Context limit \(tokens\))$/u).fill('131072')
  await dialog.getByLabel(/^(最大输出 Token 数|Maximum output tokens)$/u).fill('256')
  await dialog.getByRole('button', { name: /^(保存|Save)$/u }).click()
  await dialog.waitFor({ state: 'hidden' })
}

beforeAll(async () => {
  if (process.platform !== 'darwin') return
  await fixture.initialize(); await mkdir(artifact, { recursive: true })
  appDirectory = join(fixture.directory, 'apps/desktop')
  await mkdir(appDirectory, { recursive: true })
  for (const part of ['lib', 'renderer', 'resources', 'scripts/node-bin']) {
    await cp(join(HARNESS_REPOSITORY, 'apps/desktop', part), join(appDirectory, part), { recursive: true })
  }
  await cp(join(HARNESS_REPOSITORY, 'apps/desktop/package.json'), join(appDirectory, 'package.json'))
  await symlink(join(HARNESS_REPOSITORY, 'apps/desktop/node_modules'), join(appDirectory, 'node_modules'), 'junction')
  runtimeDirectory = preparedRuntime ?? join(fixture.directory, 'runtime-project')
  if (preparedRuntime !== undefined) return
  const nodeVersion = execFileSync(electron, ['-p', 'process.versions.node'], {
    encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
  prepareDevelopmentProject({ projectDir: runtimeDirectory,
    cliDir: join(HARNESS_REPOSITORY, 'apps/cli'), hostDir: join(HARNESS_REPOSITORY, 'apps/desktop-host'),
    dependencyDir: join(HARNESS_REPOSITORY, 'node_modules/.pnpm/node_modules'), target: desktopTarget,
    release: { schemaVersion: 1, version: '0.2.2-rc.3', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      nodeVersion, pnpmVersion: (require('pnpm') as { version: string }).version },
  })
}, 60_000)
afterAll(async () => { await stop(); await fixture.close() }, 60_000)

it.skipIf(process.platform !== 'darwin')('keeps model records and replaced keys after real Electron restarts, including an empty final configuration', { timeout: 240_000, retry: 0 }, async () => {
  onTestFailed(async () => {
    await writeFile(join(artifact, 'main.log'), mainOutput)
    await writeFile(join(artifact, 'provider-calls.json'), JSON.stringify(fixture.calls, null, 2))
    if (page !== undefined && !page.isClosed()) {
      await page.screenshot({ path: join(artifact, 'failure.png') })
      await writeFile(join(artifact, 'failure.txt'), await page.locator('body').ariaSnapshot())
    }
  })
  await start(); await open()
  expect((await models()).models).toEqual([])
  await add()
  const saved = await models()
  expect(saved.models).toHaveLength(1)
  expect(saved.defaultId).toBe(saved.models[0]!.id)
  await page.getByRole('button', { name: /^(编辑|Edit)$/u }).click()
  const editor = page.getByRole('dialog', { name: /^(编辑|Edit)$/u })
  expect(await editor.getByLabel(/^(API Key|API key)$/u).inputValue()).toBe('')
  await editor.getByLabel(/^(API Key|API key)$/u).fill('desktop-key-replaced')
  await editor.getByRole('button', { name: /^(保存|Save)$/u }).click()
  await editor.waitFor({ state: 'hidden' })
  await page.locator('.ant-table-content').evaluate((element) => { element.scrollLeft = 0 })
  await page.screenshot({ path: join(artifact, 'models-light.png') })
  await stop(); await start(); await open()
  const restored = await models()
  expect(restored.models).toEqual(saved.models)
  expect(restored.defaultId).toBe(saved.defaultId)
  await page.getByRole('button', { name: /^(测试连接|Test connection)$/u }).click()
  await expect.poll(() => fixture.calls.at(-1)?.key).toBe('Bearer desktop-key-replaced')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^(新建会话|New session|New chat)$/u }).last().click()
  await page.getByRole('button', { name: /^(选择模型|Select model)/u }).click()
  await page.getByRole('menuitem', { name: /^(模型|Model)/u }).click()
  await page.getByRole('menuitemradio', { name: '桌面模型', exact: true }).click()
  const prompt = 'Reply with one sentence.'
  const composer = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, composer, prompt)
  await expect.poll(() => composer.innerText()).toBe(prompt)
  await page.keyboard.press('Enter')
  const conversationCall = () => fixture.calls.find(call => call.path.endsWith('/chat/completions') &&
    Array.isArray(call.body.tools) && call.body.tools.length > 0 &&
    JSON.stringify(call.body.messages).includes(prompt))
  await expect.poll(conversationCall, { timeout: 30_000 }).toBeDefined()
  expect(conversationCall()).toMatchObject({
    key: 'Bearer desktop-key-replaced', body: { model: 'fixture-model', max_completion_tokens: 256 },
  })
  await page.getByRole('paragraph').filter({ hasText: /^模型调用成功$/u }).waitFor({ timeout: 30_000 })
  await open()
  await application!.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await application!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('dsh-app://app/'))
    window?.setSize(840, 700)
  })
  await page.locator('[data-ds-dark-theme]').first().waitFor({ state: 'attached' })
  await page.getByRole('button', { name: /^(编辑|Edit)$/u }).click()
  const restartedEditor = page.getByRole('dialog', { name: /^(编辑|Edit)$/u })
  await restartedEditor.waitFor()
  await page.screenshot({ path: join(artifact, 'editor-dark-narrow.png') })
  await restartedEditor.getByRole('button', { name: /^(保存|Save)$/u }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifact, 'editor-dark-narrow-bottom.png') })
  await page.keyboard.press('Escape'); await restartedEditor.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: /^(停用|Disable)$/u }).click()
  await page.getByRole('dialog', { name: /^(停用此模型？|Disable this model\?)$/u }).getByRole('button', { name: /^(确定|Confirm)$/u }).click()
  await expect.poll(async () => (await models()).defaultId).toBeNull()
  await stop(); await start(); await open()
  expect((await models()).models[0]!.enabled).toBe(false)
  await page.getByRole('button', { name: /^(删除|Delete)$/u }).click()
  await page.getByRole('dialog', { name: /^(删除此模型？|Delete this model\?)$/u }).getByRole('button', { name: /^(确定|Confirm)$/u }).click()
  await expect.poll(async () => (await models()).models.length).toBe(0)
  await stop(); await start(); await open()
  expect((await models()).models).toEqual([])
  expect(consoleErrors).toEqual([])
  await writeFile(join(artifact, 'result.json'), JSON.stringify({ platform: process.platform, restarts: 3, modelCalls: fixture.calls.filter(call => call.path.endsWith('/chat/completions')).length }))
})
