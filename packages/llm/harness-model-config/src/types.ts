/** 产品模型配置的无密钥传输类型。 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** 一条独立模型配置的稳定身份。 */
export type HarnessModelId = Branded<'HarnessModelId'>
/** 已实现的供应商协议。 */
export type ModelProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai'
/** 内置供应商及其允许协议。 */
export interface ModelProviderDefinition {
  key: string
  name: string
  protocols: ModelProtocol[]
  defaultProtocol: ModelProtocol
  baseUrl: string
  catalogProvider?: string
}
/** 表单输入；API Key 仅沿输入方向传输。 */
export interface ModelConfigInput {
  id?: HarnessModelId
  name: string
  providerKey: string
  protocol: ModelProtocol
  baseUrl: string
  model: string
  apiKey?: string
  timeoutSeconds: number
  contextWindow?: number | undefined
  maxOutputTokens?: number | undefined
  imageInput: boolean
  reasoningEffort?: string | undefined
}
/** 页面可见模型；不包含凭据地址或值。 */
export interface ModelConfigView extends Omit<ModelConfigInput, 'id' | 'apiKey'> {
  id: HarnessModelId
  enabled: boolean
  credentialConfigured: boolean
  effectiveContextWindow: number
  effectiveMaxOutputTokens: number
  reasoningEfforts: string[]
}
/** 页面完整快照；清理失败不撤销已提交的业务修改。 */
export interface ModelConfigSnapshot {
  revision: number
  providers: ModelProviderDefinition[]
  modelHints: {
    providerKey: string
    model: string
    protocol: string
    contextWindow: number
    maxOutputTokens: number
    reasoningEfforts: string[]
  }[]
  models: ModelConfigView[]
  defaultId: HarnessModelId | null
  cleanupPending: boolean
  runtimeError: string | null
}
/** 模型配置的条件变更。 */
export interface ModelConfigMutation {
  id: HarnessModelId
  expectedRevision: number
  replacementDefaultId?: HarnessModelId
}
/** 真实目录网络检查结果；不表示生成或工具能力通过。 */
export interface ModelConnectionResult {
  revision: number
  status: 'connected' | 'failed' | 'unsupported' | 'stale'
  message: string
  elapsedMs: number
  checkedAt: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * 模型配置完成持久化后的失效通知。
     * @mode emit
     * @param revision - 已提交修订。
     */
    'model-config/changed'(revision: number): void
  }
}
