/** 模型页面的数据代际、并发刷新与失败保留。 */
import { Context } from '@deepseek-ai/cordis'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelConfigSnapshot } from '@deepseek-ai/dsh-harness-model-config/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DirectModelsPage } from '../src/client/direct-page.ts'

function snapshot(revision: number): ModelConfigSnapshot {
  return { revision, providers: [], modelHints: [], models: [], defaultId: null, cleanupPending: false, runtimeError: null }
}

function bench(list: () => Promise<RemoteResult<ModelConfigSnapshot>>) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  new TestRemote(ctx, { modelConfig: { list } })
  return new DirectModelsPage(ctx, () => '加载失败')
}

it('drops a response from the previous Host after reset', async () => {
  const pending = Promise.withResolvers<RemoteResult<ModelConfigSnapshot>>()
  const page = bench(() => pending.promise)
  const loading = page.load()
  page.reset()
  pending.resolve({ ok: true, value: snapshot(9) })
  expect(await loading).toBeNull()
  expect(page.store.getSnapshot()).toEqual({ data: null, loading: false, error: null, generation: 1 })
})

it('keeps the newest refresh and does not publish a lower revision', async () => {
  const pending = Promise.withResolvers<RemoteResult<ModelConfigSnapshot>>()
  const list = vi.fn<() => Promise<RemoteResult<ModelConfigSnapshot>>>()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ ok: true, value: snapshot(3) })
    .mockResolvedValueOnce({ ok: true, value: snapshot(2) })
  const page = bench(list)
  const first = page.load()
  expect((await page.load())?.revision).toBe(3)
  pending.resolve({ ok: true, value: snapshot(1) })
  await first
  expect((await page.load())?.revision).toBe(3)
  expect(page.store.getSnapshot().data?.revision).toBe(3)
})

it('retains visible rows and exposes a retryable error when reload fails', async () => {
  const list = vi.fn<() => Promise<RemoteResult<ModelConfigSnapshot>>>()
    .mockResolvedValueOnce({ ok: true, value: snapshot(2) })
    .mockRejectedValueOnce(new Error('disconnected'))
  const page = bench(list)
  await page.load()
  expect(await page.load()).toBeNull()
  expect(page.store.getSnapshot()).toMatchObject({ data: { revision: 2 }, loading: false, error: '加载失败' })
})
