/** 产品固定供应商目录；默认地址只用于新表单预填。 */
import { catalogModels, getSupportedThinkingLevels } from '@deepseek-ai/dsh-llm-pi-ai/model-config'
import { z } from 'zod'
import type { ModelConfigInput, ModelConfigSnapshot, ModelProviderDefinition } from './types.ts'

/** 随产品发布的供应商。 */
export const providers: ModelProviderDefinition[] = [
  { key: 'deepseek', name: 'DeepSeek', protocols: ['openai-completions'], defaultProtocol: 'openai-completions', baseUrl: 'https://api.deepseek.com', catalogProvider: 'deepseek' },
  { key: 'doubao', name: '豆包', protocols: ['openai-completions'], defaultProtocol: 'openai-completions', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { key: 'qwen', name: '千问', protocols: ['openai-completions'], defaultProtocol: 'openai-completions', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', catalogProvider: 'alibaba' },
  { key: 'openai', name: 'OpenAI', protocols: ['openai-completions', 'openai-responses'], defaultProtocol: 'openai-completions', baseUrl: 'https://api.openai.com/v1', catalogProvider: 'openai' },
  { key: 'anthropic', name: 'Anthropic', protocols: ['anthropic-messages'], defaultProtocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', catalogProvider: 'anthropic' },
  { key: 'google', name: 'Google Gemini', protocols: ['google-generative-ai'], defaultProtocol: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', catalogProvider: 'google' },
  { key: 'other', name: '其他', protocols: ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'], defaultProtocol: 'openai-completions', baseUrl: '' },
]

/** 持久化和表单共同使用的字段校验；业务关联由服务校验。 */
export const modelFields = z.object({
  name: z.string().trim().min(1), providerKey: z.string().min(1),
  protocol: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']),
  baseUrl: z.string().trim().min(1), model: z.string().trim().min(1),
  timeoutSeconds: z.number().int().positive().max(Math.floor(2_147_483_647 / 1000)),
  contextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxOutputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  imageInput: z.boolean(), reasoningEffort: z.string().optional(),
})

/** 可定位到表单字段的业务校验失败。 */
export class InvalidModelField extends Error {
  constructor(message: string, readonly field: string) { super(message) }
}

/**
 * 解析准确匹配的目录信息，未知模型必须显式声明容量。
 * @param input - 服务已验证的模型字段。
 * @returns 供应商、有效容量和可选推理等级。
 */
export function modelMetadata(input: Omit<ModelConfigInput, 'id' | 'apiKey'>): {
  provider: ModelProviderDefinition
  contextWindow: number
  maxTokens: number
  efforts: ReturnType<typeof getSupportedThinkingLevels>
  catalog: ReturnType<ReturnType<typeof catalogModels>['get']>
} {
  const provider = providers.find(item => item.key === input.providerKey)
  if (provider === undefined) throw new InvalidModelField('请选择内置供应商', 'providerKey')
  if (!provider.protocols.includes(input.protocol)) throw new InvalidModelField('请选择供应商支持的协议', 'protocol')
  const known = provider.catalogProvider === undefined ? undefined : catalogModels(provider.catalogProvider).get(input.model)
  const catalog = known?.api === input.protocol ? known : undefined
  const contextWindow = input.contextWindow ?? catalog?.contextWindow
  const maxTokens = input.maxOutputTokens ?? catalog?.maxTokens
  if (contextWindow === undefined) throw new InvalidModelField('请填写上下文上限', 'contextWindow')
  if (maxTokens === undefined) throw new InvalidModelField('请填写最大输出 Token 数', 'maxOutputTokens')
  if (input.maxOutputTokens !== undefined && maxTokens > contextWindow) throw new InvalidModelField('最大输出 Token 数不能超过上下文上限', 'maxOutputTokens')
  const efforts = catalog?.reasoning ? getSupportedThinkingLevels(catalog) : []
  if (input.reasoningEffort !== undefined && !efforts.some(effort => effort === input.reasoningEffort)) throw new InvalidModelField('该模型及协议不支持所选推理强度', 'reasoningEffort')
  return { provider, contextWindow, maxTokens, efforts, catalog }
}

/**
 * 收集内置供应商的准确协议匹配目录。
 * @returns 表单候选，不代表端点已可用。
 */
export function modelHints(): ModelConfigSnapshot['modelHints'] {
  return providers.flatMap(provider => provider.catalogProvider === undefined ? [] : [...catalogModels(provider.catalogProvider).values()]
    .filter(model => provider.protocols.some(protocol => protocol === model.api))
    .map(model => ({
      providerKey: provider.key, model: model.id, protocol: model.api,
      contextWindow: model.contextWindow, maxOutputTokens: model.maxTokens,
      reasoningEfforts: model.reasoning ? getSupportedThinkingLevels(model) : [],
    })))
}
