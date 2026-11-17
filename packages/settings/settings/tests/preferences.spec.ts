/** 固定运行树可保存账号偏好，同时保持部署配置不可写。 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { configurationFixture } from './configuration-fixture.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const original = await importOriginal<typeof atomic>()
  return { ...original, writeFileAtomic: vi.fn(original.writeFileAtomic) }
})
afterEach(() => { vi.mocked(atomic.writeFileAtomic).mockClear() })

it('saves live preferences without a configuration editor and restores them after restart', async () => {
  const { ctx, home, profile, start } = await configurationFixture({ editor: false, hmr: false, preferences: true })
  const before = readFileSync(profile.patchPath, 'utf8')
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'first')!
  const fiber = entry.fiber
  expect(ctx.get('configEditor')).toBeUndefined()
  await ctx.settings.update('first', { count: 8 })
  expect(entry.fiber === fiber).toBe(true)
  expect(ctx.settings.describe().find(row => row.ns === 'first')).toMatchObject({ writable: true, value: { count: 8 } })
  expect(ctx.settings.describe().find(row => row.ns === 'second')).toMatchObject({ writable: false })
  expect(JSON.parse(readFileSync(join(home, 'preferences.json'), 'utf8'))).toEqual({ first: { token: 'private', count: 8 } })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  await ctx.fiber.dispose()
  const restored = await start()
  await vi.waitFor(() => { expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 8 }) })
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 8 })
  await restored.settings.mutate('first', [{ op: 'unset', path: ['count'] }])
  expect(restored.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
})

it('keeps disk and live values unchanged when persistence fails', async () => {
  const { ctx, home } = await configurationFixture({ editor: false, hmr: false, preferences: true })
  await ctx.settings.update('first', { count: 3 })
  const path = join(home, 'preferences.json')
  const before = readFileSync(path, 'utf8')
  vi.mocked(atomic.writeFileAtomic).mockRejectedValueOnce(new Error('磁盘写入失败'))
  await expect(ctx.settings.update('first', { count: 9 })).rejects.toMatchObject({ code: 'SETTINGS_PREFERENCES_STORAGE' })
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 3 })
  expect(readFileSync(path, 'utf8')).toBe(before)
  await ctx.settings.update('first', { count: 4 })
  expect(ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 4 })
})

it('refuses protected namespaces, ordinary fields, invalid values and stale concurrent writes', async () => {
  const { ctx, home } = await configurationFixture({ editor: false, hmr: false, preferences: true })
  await ctx.settings.update('first', { count: 5 })
  const path = join(home, 'preferences.json')
  const before = readFileSync(path, 'utf8')
  await expect(ctx.settings.update('second', { count: 9 })).rejects.toThrow('部署管理')
  await expect(ctx.settings.update('first', { ordinary: 'changed' })).rejects.toThrow('not volatile')
  await expect(ctx.settings.update('first', { count: 0 })).rejects.toThrow()
  expect(readFileSync(path, 'utf8')).toBe(before)
  const revision = ctx.settings.describe().find(row => row.ns === 'first')!.revision
  const results = await Promise.allSettled([
    ctx.settings.update('first', { count: 6 }, revision),
    ctx.settings.update('first', { count: 7 }, revision),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
})

it('keeps account preferences separate and rejects persisted ordinary fields', async () => {
  const first = await configurationFixture({ editor: false, hmr: false, preferences: true })
  const second = await configurationFixture({ editor: false, hmr: false, preferences: true })
  await first.ctx.settings.update('first', { count: 11 })
  expect(second.ctx.settings.describe().find(row => row.ns === 'first')!.value).toMatchObject({ count: 2 })
  await first.ctx.fiber.dispose()
  writeFileSync(join(first.home, 'preferences.json'), JSON.stringify({ first: { ordinary: 'changed' } }))
  const restored = await first.start()
  await expect(restored.settings.update('first', { count: 4 })).rejects.toThrow('非即时配置')
  expect(JSON.parse(readFileSync(join(first.home, 'preferences.json'), 'utf8'))).toEqual({ first: { ordinary: 'changed' } })
})
