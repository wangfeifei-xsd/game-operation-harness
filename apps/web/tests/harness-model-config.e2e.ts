/** 真实 harness 产品入口：直接配置、冲突恢复、持久化和供应商调用闭环。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import type { ModelConfigSnapshot } from '@deepseek-ai/dsh-harness-model-config/types'
import { HarnessProductFixture, HARNESS_REPOSITORY, productRemote } from './harness-product-fixture.ts'
import { captureStableAria, compareOrRefreshGolden, webSnapshotMode } from './scaffold.ts'
import { writeComposerDraft } from './support.ts'

const fixture = new HarnessProductFixture()
let browser: Browser
let page: Page
const errors: string[] = []
const removedCalls: string[] = []
const artifact = join(HARNESS_REPOSITORY, '.artifacts/harness-model-web')

async function login(): Promise<void> {
  await page.context().request.get(`${fixture.origin}/harness/api/session`)
  const response = await page.context().request.post(`${fixture.origin}/harness/api/login`, { data: { login_name: 'alpha' },
    headers: { origin: fixture.origin } })
  expect(response.status(), await response.text()).toBe(200)
  await page.goto(fixture.origin)
  try {
    await page.getByRole('button', { name: '模型配置', exact: true }).waitFor({ timeout: 30_000 })
  } catch (error) {
    await page.screenshot({ path: join(artifact, 'startup-failure.png') })
    await writeFile(join(artifact, 'startup-failure.txt'), JSON.stringify({ url: page.url(), errors,
      aria: await page.locator('body').ariaSnapshot(), host: fixture.output }, null, 2))
    throw error
  }
}
async function snapshot(): Promise<ModelConfigSnapshot> {
  const result = await productRemote<ModelConfigSnapshot>(page, 'modelConfig/list', {})
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
async function openModels(): Promise<void> {
  await page.getByRole('button', { name: '模型配置', exact: true }).click()
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor()
}
async function add(name: string, key: string): Promise<void> {
  await page.getByRole('button', { name: '新增模型', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: '新增模型', exact: true })
  await dialog.getByLabel('模型名称', { exact: true }).fill(name)
  await dialog.getByLabel('供应商', { exact: true }).click()
  await page.getByRole('option', { name: '其他', exact: true }).waitFor()
  if (name === '模型 A') await page.screenshot({ path: join(artifact, 'providers-light.png') })
  await page.getByRole('option', { name: '其他', exact: true }).click()
  await dialog.getByLabel('接口地址', { exact: true }).fill(fixture.providerUrl)
  await dialog.getByLabel('API Key', { exact: true }).fill(key)
  await dialog.getByLabel('模型标识', { exact: true }).fill('fixture-model')
  await dialog.getByLabel('上下文上限（Token）', { exact: true }).fill('131072')
  await dialog.getByLabel('最大输出 Token 数', { exact: true }).fill('256')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('row').filter({ hasText: name }).waitFor()
}
const row = (name: string) => page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) })

beforeAll(async () => {
  await fixture.initialize(); await fixture.startWeb(); await mkdir(artifact, { recursive: true })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  page.setDefaultTimeout(15_000)
  page.on('pageerror', (error) => { errors.push(error.message) })
  page.on('request', (request) => { if (/\/api\/account\//u.test(request.url())) removedCalls.push(request.url()) })
  await login()
}, 90_000)
afterAll(async () => { await browser?.close(); await fixture.close() })

it('configures the actual protected product without model authorization and persists its selected call', async () => {
  onTestFailed(async () => {
    await page?.screenshot({ path: join(artifact, 'failure.png') })
    await writeFile(join(artifact, 'host.log'), fixture.output)
    await writeFile(join(artifact, 'provider-calls.json'), JSON.stringify(fixture.calls, null, 2))
    await writeFile(join(artifact, 'failure.txt'), await page.locator('body').ariaSnapshot())
  })
  await openModels()
  expect((await snapshot()).models).toEqual([])
  const empty = await captureStableAria(page, '[data-shortcut-modal="settings"]', fixture.directory)
  await compareOrRefreshGolden(join(HARNESS_REPOSITORY, 'apps/web/tests/expected/harness-model-config/empty.expected.md'),
    empty, webSnapshotMode())
  await add('模型 A', 'fixture-key-a')
  const first = (await snapshot()).models[0]!
  await add('模型 B', 'fixture-key-b')
  await row('模型 B').getByRole('button', { name: '设为默认', exact: true }).click()
  await expect.poll(async () => (await snapshot()).defaultId).not.toBe(first.id)

  await row('模型 A').getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '编辑', exact: true })
  expect(await dialog.getByLabel('API Key', { exact: true }).inputValue()).toBe('')
  await dialog.getByLabel('模型名称', { exact: true }).fill('模型 A 修改')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await row('模型 A 修改').getByRole('button', { name: '测试连接', exact: true }).click()
  await page.getByText('连接成功', { exact: false }).waitFor()
  expect(fixture.calls.at(-1)).toMatchObject({ path: '/v1/models', key: 'Bearer fixture-key-a' })

  // 同一真实 Host 上的第二写入产生修订冲突，重新加载明确放弃草稿。
  await row('模型 A 修改').getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByLabel('模型名称', { exact: true }).fill('未提交的草稿')
  const current = await snapshot()
  const second = current.models.find(model => model.id !== first.id)!
  expect((await productRemote(page, 'modelConfig/setDefault', { request: { id: first.id,
    expectedRevision: current.revision } })).ok).toBe(true)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.getByText(/配置已被其他窗口修改/u).waitFor()
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '重新加载已保存的配置并放弃当前草稿？', exact: true })
  await confirm.getByRole('button', { name: '确定', exact: true }).click()
  await expect.poll(() => dialog.getByLabel('模型名称', { exact: true }).inputValue()).toBe('模型 A 修改')
  await dialog.getByLabel('API Key', { exact: true }).fill('fixture-key-replaced')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await row('模型 A 修改').getByRole('button', { name: '测试连接', exact: true }).click()
  await expect.poll(() => fixture.calls.at(-1)?.key).toBe('Bearer fixture-key-replaced')

  const populated = await captureStableAria(page, '[data-shortcut-modal="settings"] .ant-table', fixture.directory)
  await compareOrRefreshGolden(join(HARNESS_REPOSITORY,
    'apps/web/tests/expected/harness-model-config/configured.expected.md'), populated, webSnapshotMode())
  await page.locator('.ant-table-content').evaluate((element) => { element.scrollLeft = 0 })
  await page.screenshot({ path: join(artifact, 'models-light.png') })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 480, height: 820 })
  await row('模型 A 修改').getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByLabel('模型名称', { exact: true }).fill('长模型名称'.repeat(18))
  await page.screenshot({ path: join(artifact, 'editor-dark-narrow.png') })
  await dialog.getByLabel('供应商', { exact: true }).click()
  await page.getByRole('option', { name: '其他', exact: true }).waitFor()
  await page.screenshot({ path: join(artifact, 'providers-dark-narrow.png') })
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: '保存', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(artifact, 'editor-dark-narrow-bottom.png') })
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: '放弃未保存的修改？', exact: true }).getByRole('button', { name: '确定', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: '模型配置', exact: true }).waitFor()
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ colorScheme: 'light' })

  await fixture.stopWeb(); await fixture.startWeb(); await login(); await openModels()
  const restored = await snapshot()
  expect(restored.defaultId).toBe(first.id)
  expect(restored.models).toHaveLength(2)
  expect(JSON.stringify(restored)).not.toContain('fixture-key-')
  await row('模型 A 修改').getByRole('button', { name: '测试连接', exact: true }).click()
  await expect.poll(() => fixture.calls.at(-1)?.key).toBe('Bearer fixture-key-replaced')
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: '新建会话', exact: true }).last().click()
  await page.getByRole('button', { name: /^选择模型/u }).click()
  await page.getByRole('menuitem', { name: /^模型/u }).click()
  await page.getByRole('menuitemradio', { name: '模型 A 修改', exact: true }).click()
  const prompt = 'Reply with one sentence.'
  const composer = page.locator('[data-composer-input]').first()
  await writeComposerDraft(page, composer, prompt)
  await expect.poll(() => composer.innerText()).toBe(prompt)
  await page.keyboard.press('Enter')
  const conversationCall = () => fixture.calls.find(call => call.path.endsWith('/chat/completions') &&
    Array.isArray(call.body.tools) && call.body.tools.length > 0 &&
    JSON.stringify(call.body.messages).includes(prompt))
  await expect.poll(conversationCall, { timeout: 30_000 }).toBeDefined()
  const call = conversationCall()!
  expect(call).toMatchObject({ key: 'Bearer fixture-key-replaced', body: { model: 'fixture-model', max_completion_tokens: 256 } })
  await page.getByRole('paragraph').filter({ hasText: /^模型调用成功$/u }).waitFor({ timeout: 30_000 })

  await openModels()
  await row('模型 A 修改').getByRole('button', { name: '停用', exact: true }).click()
  const disable = page.getByRole('dialog', { name: '停用此模型？', exact: true })
  await disable.getByLabel('替代默认模型', { exact: true }).click()
  await disable.locator('.ant-select-item-option-content').getByText('模型 B', { exact: true }).click()
  await disable.getByRole('button', { name: '确定', exact: true }).click()
  await disable.waitFor({ state: 'hidden' })
  expect((await snapshot()).defaultId).toBe(second.id)
  for (const name of ['模型 A 修改', '模型 B']) {
    await row(name).getByRole('button', { name: '删除', exact: true }).click()
    const removal = page.getByRole('dialog', { name: '删除此模型？', exact: true })
    await removal.getByRole('button', { name: '确定', exact: true }).click()
    await removal.waitFor({ state: 'hidden' })
  }
  expect((await snapshot()).defaultId).toBeNull()
  await fixture.stopWeb(); await fixture.startWeb(); await login(); await openModels()
  expect((await snapshot()).models).toEqual([])
  expect(removedCalls).toEqual([])
  expect(errors).toEqual([])
  const storage = await readFile(join(fixture.config.storage.root, 'users/user_alpha/storages/harness_models.json'), 'utf8')
  expect(storage).not.toContain('fixture-key-')
}, 240_000)
