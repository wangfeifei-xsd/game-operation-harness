/** 使用明确保存的模型记录与密钥访问真实 Chat Completions 服务。 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import * as Models from '../src/index.ts'

const key = process.env.OPENAI_API_KEY
const baseUrl = process.env.OPENAI_BASE_URL

it.skipIf(!key || !baseUrl)('generates with an explicitly saved credential after reopening the model store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-real-model-'))
  let ctx = new Context()
  const boot = async (): Promise<void> => {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root: join(root, 'storages') })
    await ctx.plugin(LocalCredentialProvider, { path: join(root, '.credentials.yaml'), watch: false })
    await ctx.plugin(Llm)
    await ctx.plugin(DefaultModel, { sourceRequired: true, provider: 'openai', model: 'gpt-5.4-mini' })
    await ctx.plugin(Models, { root: join(root, 'storages') })
  }
  try {
    await boot()
    const saved = await ctx.harnessModelConfig.save({
      name: '真实供应商验证', providerKey: 'openai', protocol: 'openai-completions',
      baseUrl: baseUrl!, apiKey: key!, model: process.env.DSH_MODEL_CONFIG_REAL_MODEL ?? 'gpt-5.4-mini',
      timeoutSeconds: 60, contextWindow: 8192, maxOutputTokens: 256, imageInput: false,
    }, 0)
    expect(JSON.stringify(saved)).not.toContain(key!)
    await ctx.fiber.dispose()
    ctx = new Context()
    await boot()
    const selection = ctx.agentDefaultModel.requireSelection()
    let text = ''
    let finish: string | undefined
    for await (const chunk of ctx.llm.stream({ ...selection, tools: [], messages: [createUserMessage({
      content: [{ type: 'text', text: 'Reply with the single word OK.' }], source: { kind: 'user' },
    })] })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'finish') finish = chunk.reason.kind
      if (chunk.type === 'finish' && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure.message.replaceAll(key!, '[key]').replaceAll(baseUrl!, '[endpoint]'))
      }
    }
    expect(finish).toBe('stop')
    expect(text.trim().length).toBeGreaterThan(0)
    expect(await readFile(join(root, 'storages/harness_models.json'), 'utf8')).not.toContain(key!)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
