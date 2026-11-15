/** 模型配置 Remote 的客户端安全类型与错误详情。 */
export type { ModelConfigInput, ModelConfigMutation, ModelConfigSnapshot, ModelConnectionResult } from '@deepseek-ai/dsh-harness-model-config/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'model-config/rejected': { reason: string; field: string | null }
  }
}
