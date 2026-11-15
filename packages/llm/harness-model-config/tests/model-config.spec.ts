/** 产品模型配置的持久化、部分失败、并发及实际协议请求。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import Storage, { StorageError, type KvUnit } from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as Models from '../src/index.ts'
import type { ModelConfigInput, ModelProtocol } from '../src/types.ts'
import { closeMockServers, mockServer, textEvents, anthropicTextEvents } from '../../llm-pi-ai/tests/mock-server.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await closeMockServers()
  while (cleanups.length) await cleanups.pop()!()
})
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'harness-models-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function boot(root: string) {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: join(root, 'storages') })
  await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
  await ctx.plugin(Llm)
  await ctx.plugin(DefaultModel, { sourceRequired: true, provider: 'legacy', model: 'legacy' })
  const facet = ctx.storage.backend.get('json').kv!
  const open = facet.open.bind(facet)
  let unit!: KvUnit
  vi.spyOn(facet, 'open').mockImplementation(async (descriptor) => { unit = await open(descriptor); return unit })
  await ctx.plugin(Models, { root: join(root, 'storages') })
  return { ctx, models: ctx.harnessModelConfig, unit }
}
function input(patch: Partial<ModelConfigInput> = {}): ModelConfigInput {
  return { name: '测试模型', providerKey: 'other', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:1/gateway/v1', apiKey: 'fixture-key', model: 'test-model', timeoutSeconds: 60, contextWindow: 8192, maxOutputTokens: 1024, imageInput: false, ...patch }
}
async function generate(ctx: Context, provider: string, model: string) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider, model, messages: [createUserMessage({ content: [{ type: 'text', text: 'Hello' }], source: { kind: 'user' } })], tools: [] })) chunks.push(chunk)
  return chunks
}

function responseEvents(protocol: ModelProtocol): NonNullable<Parameters<typeof mockServer>[0][number]['events']> {
  if (protocol === 'openai-completions') return [...textEvents]
  if (protocol === 'anthropic-messages') return [...anthropicTextEvents]
  if (protocol === 'google-generative-ai') return [JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } })]
  const item = { type: 'message', id: 'msg_reply', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }
  return [
    JSON.stringify({ type: 'response.created', response: { id: 'resp_reply' } }),
    JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }),
    JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }),
    JSON.stringify({ type: 'response.completed', response: { id: 'resp_reply', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }),
  ]
}

it('starts empty without using legacy credentials and persists models with their default in one snapshot', async () => {
  const root = await directory()
  vi.stubEnv('DEEPSEEK_API_KEY', 'legacy-environment-key')
  const first = await boot(root)
  await first.ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'deepseek'), () => Promise.resolve({ kind: 'api-key', key: 'legacy-key' }))
  expect((await first.models.list()).models).toEqual([])
  expect((await first.models.list()).runtimeError).toBeNull()
  expect(first.ctx.agentDefaultModel.currentSelection()).toBeNull()
  expect(() => first.ctx.agentDefaultModel.requireSelection()).toThrow('请先')
  const saved = await first.models.save(input(), 0)
  expect(saved.models).toHaveLength(1)
  expect(saved.defaultId).toBe(saved.models[0]!.id)
  expect(JSON.stringify(saved)).not.toContain('fixture-key')
  expect(JSON.stringify(saved)).not.toContain('harness-model-config/key-')
  await first.ctx.fiber.dispose()
  const second = await boot(root)
  const restored = await second.models.list()
  expect(restored.models).toEqual(saved.models)
  expect(second.ctx.agentDefaultModel.requireSelection()).toMatchObject({ model: 'test-model' })
  await second.models.remove({ id: restored.defaultId!, expectedRevision: restored.revision })
  expect(second.ctx.agentDefaultModel.currentSelection()).toBeNull()
  await second.ctx.fiber.dispose()
  const third = await boot(root)
  expect((await third.models.list()).models).toEqual([])
  expect((await third.ctx.credentials.listRecords()).map(record => String(record.key))).toEqual(['llm-pi-ai/deepseek'])
})

it('keeps independent keys and requires an explicit replacement when disabling the default', async () => {
  const { models, ctx } = await boot(await directory())
  const a = (await models.save(input(), 0)).models[0]!
  const b = (await models.save(input({ name: '第二个模型', apiKey: 'another-key' }), 1)).models[1]!
  await expect(models.setEnabled({ id: a.id, expectedRevision: 2 }, false)).rejects.toMatchObject({ field: 'replacementDefaultId' })
  const result = await models.setEnabled({ id: a.id, expectedRevision: 2, replacementDefaultId: b.id }, false)
  expect(result.defaultId).toBe(b.id)
  expect(await ctx.credentials.listRecords()).toHaveLength(2)
  await models.remove({ id: a.id, expectedRevision: 3 })
  expect(await ctx.credentials.listRecords()).toHaveLength(1)
  await models.setEnabled({ id: b.id, expectedRevision: 4 }, false)
  expect(ctx.agentDefaultModel.currentSelection()).toBeNull()
})

it('rejects stale edits and invalid fields before creating credentials', async () => {
  const { models, ctx } = await boot(await directory())
  await models.save(input(), 0)
  await expect(models.save(input({ name: '过期草稿' }), 0)).rejects.toMatchObject({ code: 'MODEL_CONFIG_CONFLICT' })
  await expect(models.save(input({ providerKey: 'not-builtin' }), 1)).rejects.toMatchObject({ field: 'providerKey' })
  await expect(models.save(input({ providerKey: 'deepseek', protocol: 'anthropic-messages' }), 1)).rejects.toMatchObject({ field: 'protocol' })
  await expect(models.save(input({ contextWindow: undefined }), 1)).rejects.toMatchObject({ field: 'contextWindow' })
  await expect(models.save(input({ baseUrl: 'https://user:password@api.example/v1?q=1' }), 1)).rejects.toMatchObject({ field: 'baseUrl' })
  expect(await ctx.credentials.listRecords()).toHaveLength(1)
})

it('keeps the old endpoint, model and key together after a failed snapshot commit', async () => {
  const root = await directory()
  const { models, ctx, unit } = await boot(root)
  const original = (await models.save(input(), 0)).models[0]!
  vi.spyOn(unit, 'setGlobal').mockRejectedValueOnce(new Error('disk full'))
  await expect(models.save(input({ id: original.id, baseUrl: 'https://new.example/v1', model: 'new-model', apiKey: 'replacement-key' }), 1)).rejects.toMatchObject({ code: 'MODEL_CONFIG_STORAGE' })
  const current = await models.list()
  expect(current.revision).toBe(1)
  expect(current.models[0]).toEqual(original)
  const records = await ctx.credentials.listRecords()
  expect(records).toHaveLength(1)
  expect(await ctx.credentials.readRecord(records[0]!.key)).toEqual({ kind: 'api-key', key: 'fixture-key' })
  expect(await readFile(join(root, 'storages/harness_models.json'), 'utf8')).not.toContain('new-model')
  await expect(models.save(input({ id: original.id, baseUrl: 'https://another.example', apiKey: '' }), 1)).rejects.toMatchObject({ field: 'apiKey' })
})

it('reports cleanup failure as committed and retries orphan cleanup on restart', async () => {
  const root = await directory()
  const { models, ctx } = await boot(root)
  const original = (await models.save(input(), 0)).models[0]!
  vi.spyOn(ctx.credentials, 'deleteRecord').mockRejectedValueOnce(new Error('busy'))
  const result = await models.save(input({ id: original.id, apiKey: 'new-key' }), 1)
  expect(result.revision).toBe(2)
  expect(result.cleanupPending).toBe(true)
  expect(await ctx.credentials.listRecords()).toHaveLength(2)
  await ctx.fiber.dispose()
  const restarted = await boot(root)
  expect((await restarted.models.list()).cleanupPending).toBe(false)
  expect(await restarted.ctx.credentials.listRecords()).toHaveLength(1)
})

it('retains the committed model and credential when a replacement credential cannot be written', async () => {
  const { models, ctx } = await boot(await directory())
  const original = (await models.save(input(), 0)).models[0]!
  vi.spyOn(ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('credential disk full'))
  await expect(models.save(input({ id: original.id, apiKey: 'replacement-key', model: 'next-model' }), 1)).rejects.toThrow()
  expect((await models.list()).models).toEqual([original])
  const records = await ctx.credentials.listRecords()
  expect(records).toHaveLength(1)
  expect(await ctx.credentials.readRecord(records[0]!.key)).toEqual({ kind: 'api-key', key: 'fixture-key' })
})

it('refuses to replace a corrupted snapshot with empty configuration', async () => {
  const root = await directory()
  const first = await boot(root)
  await first.unit.setGlobal({ revision: 1, models: 'invalid' })
  await first.ctx.fiber.dispose()
  const saved = await readFile(join(root, 'storages/harness_models.json'), 'utf8')
  await expect(boot(root)).rejects.toThrow('损坏')
  expect(await readFile(join(root, 'storages/harness_models.json'), 'utf8')).toBe(saved)
})

it('drains admitted saves on close and rejects new work while quitting', async () => {
  const { models, unit } = await boot(await directory())
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const write = unit.setGlobal.bind(unit)
  vi.spyOn(unit, 'setGlobal').mockImplementationOnce(async (value) => { entered.resolve(undefined); await release.promise; await write(value) })
  const save = models.save(input(), 0)
  await entered.promise
  const closing = models.close()
  expect(() => models.save(input(), 0)).toThrow('退出')
  release.resolve(undefined)
  expect((await save).revision).toBe(1)
  await closing
})

it('blocks new model calls and changes after storage reports an unknown outcome', async () => {
  const { models, unit } = await boot(await directory())
  await models.save(input(), 0)
  vi.spyOn(unit, 'setGlobal').mockRejectedValueOnce(new StorageError('unknown-state', 'unknown'))
  await expect(models.save(input({ name: '第二个' }), 1)).rejects.toMatchObject({ code: 'MODEL_CONFIG_STORAGE' })
  await expect(models.list()).rejects.toThrow('不确定')
})

it('performs actual directory requests and distinguishes authentication and unsupported directories', async () => {
  const server = await mockServer([{ body: '{"data":[]}' }, { status: 401 }, { status: 404 }])
  const { models } = await boot(await directory())
  const saved = await models.save(input({ baseUrl: `${server.url}/proxy/v1` }), 0)
  const request = { id: saved.defaultId!, expectedRevision: 1 }
  expect((await models.testConnection(request)).status).toBe('connected')
  expect((await models.testConnection(request)).message).toContain('验证失败')
  expect((await models.testConnection(request)).status).toBe('unsupported')
  expect(server.paths).toEqual(['/proxy/v1/models', '/proxy/v1/models', '/proxy/v1/models'])
  expect(server.headers[0]!.authorization).toBe('Bearer fixture-key')
})

it('marks late connection results stale and obeys the configured timeout', async () => {
  const server = await mockServer([{ events: [], holdOpen: true }])
  const { models } = await boot(await directory())
  const saved = await models.save(input({ baseUrl: server.url, timeoutSeconds: 1 }), 0)
  const testing = models.testConnection({ id: saved.defaultId!, expectedRevision: 1 })
  await server.requestReceived
  await models.save(input({ id: saved.defaultId!, baseUrl: server.url, apiKey: '' }), 1)
  expect((await testing).status).toBe('stale')
})

it.each([
  ['openai-completions', textEvents, '/prefix/v1/chat/completions', 'authorization', 'max_completion_tokens'],
  ['anthropic-messages', anthropicTextEvents, '/prefix/v1/messages?beta=true', 'x-api-key', 'max_tokens'],
] as const)('uses the saved %s endpoint, model, independent key and output limit', async (protocol, events, path, header, outputField) => {
  const server = await mockServer([{ events: [...events], delayMs: 10 }, { events: [...events] }])
  const { models, ctx } = await boot(await directory())
  const saved = await models.save(input({ protocol, baseUrl: `${server.url}/prefix/v1` }), 0)
  const selection = ctx.agentDefaultModel.requireSelection()
  const running = generate(ctx, selection.provider, selection.model)
  await Promise.race([server.requestReceived, running.then((chunks) => { throw new Error(JSON.stringify(chunks)) })])
  await models.save(input({ id: saved.defaultId!, protocol, baseUrl: `${server.url}/prefix/v1`, apiKey: 'next-key' }), 1)
  expect((await running).length).toBeGreaterThan(0)
  await generate(ctx, selection.provider, selection.model)
  expect(server.paths).toEqual([path, path])
  expect(server.headers[0]![header]).toContain('fixture-key')
  expect(server.headers[1]![header]).toContain('next-key')
  expect(server.requests[0]).toMatchObject({ model: 'test-model', [outputField]: 1024 })
  await models.remove({ id: saved.defaultId!, expectedRevision: 2 })
  const finish = (await generate(ctx, selection.provider, selection.model)).find(chunk => chunk.type === 'finish')
  expect(finish?.reason.kind).toBe('error')
})

it.each(['openai-responses', 'google-generative-ai'] as const)('streams saved %s requests through a gateway prefix', async (protocol) => {
  const server = await mockServer([{ events: responseEvents(protocol) }])
  const { models, ctx } = await boot(await directory())
  await models.save(input({ protocol, baseUrl: `${server.url}/gateway/v1` }), 0)
  const selection = ctx.agentDefaultModel.requireSelection()
  expect(await generate(ctx, selection.provider, selection.model)).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
  expect(server.paths).toEqual([protocol === 'openai-responses' ? '/gateway/v1/responses' : '/gateway/v1/models/test-model:streamGenerateContent?alt=sse'])
  expect(server.headers[0]![protocol === 'openai-responses' ? 'authorization' : 'x-goog-api-key']).toContain('fixture-key')
  expect(server.requests[0]).toMatchObject(protocol === 'openai-responses' ? { model: 'test-model', max_output_tokens: 1024 } : { generationConfig: { maxOutputTokens: 1024 } })
})

it.each(['openai-completions', 'openai-responses', 'google-generative-ai', 'anthropic-messages'] as const)('keeps catalog output capacity separate from the saved request limit for %s', async (protocol) => {
  const server = await mockServer([{ events: responseEvents(protocol) }])
  const { models, ctx } = await boot(await directory())
  const hint = (await models.list()).modelHints.find(item => item.protocol === protocol)!
  await models.save(input({ providerKey: hint.providerKey, protocol, model: hint.model,
    baseUrl: server.url, contextWindow: hint.contextWindow, maxOutputTokens: undefined }), 0)
  const selection = ctx.agentDefaultModel.requireSelection()
  expect(await generate(ctx, selection.provider, selection.model)).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
  const request = server.requests[0]!
  if (protocol === 'google-generative-ai') expect(server.paths[0]).toContain(`/models/${hint.model}:streamGenerateContent`)
  else expect(request).toMatchObject({ model: hint.model })
  if (protocol === 'anthropic-messages') expect(request).toMatchObject({ max_tokens: hint.maxOutputTokens })
  else {
    expect(request).not.toHaveProperty('max_tokens')
    expect(request).not.toHaveProperty('max_completion_tokens')
    expect(request).not.toHaveProperty('max_output_tokens')
    expect(request).not.toHaveProperty('generationConfig.maxOutputTokens')
  }
})
