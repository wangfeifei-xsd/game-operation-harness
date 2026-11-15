/** 真实产品入口验证注册登录、模型引导和两处桌面下载；中央接口使用隔离服务桩。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it, onTestFailed } from 'vitest'
import { HarnessProductFixture, HARNESS_REPOSITORY } from './harness-product-fixture.ts'

const fixture = new HarnessProductFixture()
const evidence = join(HARNESS_REPOSITORY, '.local/electron-remediation/ui')
let browser: Browser
let page: Page
beforeAll(async () => {
  await fixture.initialize(); await fixture.startWeb(); await mkdir(evidence, { recursive: true })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1180, height: 820 } })
}, 90_000)
afterAll(async () => { await browser?.close(); await fixture.close() })

it('keeps registration separate from login and opens model configuration only after product authentication', async () => {
  onTestFailed(async () => { await writeFile(join(evidence, 'web-host.log'), fixture.output); await page.screenshot({ path: join(evidence, 'failure.png') }) })
  await page.goto(`${fixture.origin}/harness/login`)
  await page.getByRole('button', { name: '下载桌面版', exact: true }).click()
  const downloads = page.getByRole('dialog', { name: '下载 Agent 助手' })
  await downloads.getByText('桌面版尚未发布', { exact: true }).waitFor()
  expect(await downloads.getByRole('link', { name: '下载安装包' }).count()).toBe(0)
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: '注册', exact: true }).click()
  await page.getByLabel('登录名', { exact: true }).fill('new-user')
  await page.getByLabel('显示名称', { exact: true }).fill('很长的用户显示名称用于验证侧栏截断与可访问操作')
  await page.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: '点击完成滑动验证', exact: true }).click()
  await page.getByRole('dialog', { name: '滑动验证', exact: true }).getByRole('button', { name: '确认位置' }).click()
  await page.getByRole('button', { name: '验证已通过', exact: true }).waitFor()
  await page.getByRole('button', { name: /^注\s*册$/u }).click()
  await page.getByText('注册成功，请登录', { exact: true }).waitFor()
  expect(page.url()).toContain('/harness/login')
  await page.getByLabel('密码', { exact: true }).fill('fixture-password')
  await page.getByRole('button', { name: '点击完成滑动验证', exact: true }).click()
  await page.getByRole('dialog', { name: '滑动验证', exact: true }).getByRole('button', { name: '确认位置' }).click()
  await page.getByRole('button', { name: '验证已通过', exact: true }).waitFor()
  await page.getByRole('button', { name: /^登\s*录$/u }).click()
  await page.getByRole('button', { name: '模型配置', exact: true }).waitFor({ timeout: 45_000 })
  await page.screenshot({ path: join(evidence, 'workspace-light.png') })
  await page.getByRole('button', { name: '下载桌面版', exact: true }).click()
  await downloads.getByText('桌面版尚未发布', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).last().click()
  await page.waitForURL('**/harness/login')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 440, height: 820 })
  await page.getByRole('button', { name: '下载桌面版', exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'login-dark-narrow.png') })
}, 120_000)
