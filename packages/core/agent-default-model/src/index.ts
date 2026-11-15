/**
 * Default model selection for an Agent without a session-specific selection.
 *
 * @module @deepseek-ai/dsh-agent-default-model
 */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-config-editor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Default model selection for Agents created without an explicit model. */
    agentDefaultModel: AgentDefaultModelConfig
  }
}

/** Default model selection supplied by plugin configuration. */
export interface Config {
  /** 产品来源必须存在；缺失时拒绝执行，不回退静态配置。 */
  sourceRequired?: boolean
  /** Registered provider route. */
  provider: Volatile<string>
  /** Provider-owned model id. */
  model: Volatile<string>
  /** Adapter-owned reasoning effort; omission follows the provider default. */
  reasoningEffort: Volatile<string | undefined>
}

/** Project stored settings onto the Agent-facing selection type. */
function selection(settings: { provider: string; model: string; reasoningEffort?: string }): ModelSelection {
  return {
    provider: settings.provider,
    model: settings.model,
    ...settings.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: brandString<ReasoningEffortId>(settings.reasoningEffort) },
  }
}

/** 产品来源负责默认选择的读取和持久化。 */
export interface DefaultModelSource {
  /** @returns 空配置返回空。 */
  read(): ModelSelection | null
  /** @param next - 经目录校验的模型选择。 */
  save(next: ModelSelection): Promise<void>
}

/** 默认选择的唯一读写入口，产品可以注册可持久化且允许空值的来源。 */
export class AgentDefaultModelConfig extends Service {
  private source: DefaultModelSource | undefined

  /**
   * 注册唯一产品来源，卸载后产品模式仍拒绝静态回退。
   * @param source - 默认值的业务所有者。
   * @returns 撤销该注册的函数。
   */
  registerSource(source: DefaultModelSource): () => void {
    if (this.source !== undefined) throw new Error('默认模型来源已注册')
    this.source = source
    return () => { if (this.source === source) this.source = undefined }
  }

  /**
   * 执行入口读取必需的模型选择。
   * @returns 有效选择；无模型时抛出可识别错误。
   */
  requireSelection(): ModelSelection {
    const value = this.currentSelection()
    if (value === null) throw new LlmError('请先在设置中配置模型', 'NO_MODEL_CONFIGURED')
    return value
  }
  private saves: Promise<void> = Promise.resolve()

  static Config = z.object({
    sourceRequired: z.boolean().default(false),
    provider: z.string().required().volatile(),
    model: z.string().required().volatile(),
    reasoningEffort: z.string().volatile(),
  })

  constructor(private readonly ownerContext: Context, private config: Config) {
    super(ownerContext, 'agentDefaultModel')

    ownerContext.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ownerContext.fiber)) })
  }

  /**
   * Read the current default model selection.
   * @returns a detached provider, model, and optional reasoning selection.
   */
  currentSelection(): ModelSelection | null {
    if (this.source !== undefined) return this.source.read()
    if (this.config.sourceRequired) return null
    const reasoningEffort = this.config.reasoningEffort.get()
    return selection({
      provider: this.config.provider.get(), model: this.config.model.get(),
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    })
  }

  /**
   * Save the complete default model selection. A deployment without a configuration
   * editor keeps its composition entry. Saves commit in submission order; a failed
   * save rejects its caller without blocking later saves.
   * @param next - resolved selection accepted by an entry point.
   * @returns fulfillment after the optional profile write settles.
   */
  async saveSelection(next: ModelSelection): Promise<void> {
    if (this.source !== undefined) return this.source.save(next)
    if (this.config.sourceRequired) throw new LlmError('模型配置服务不可用', 'NO_MODEL_CONFIGURED')
    const entry = this.ownerContext.fiber.entry
    if (entry === undefined) return
    const editor = this.ctx.get('configEditor')
    if (editor === undefined) return
    const config = {
      provider: next.provider, model: next.model,
      ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
    }
    const saved = this.saves.then(() => editor.edit(entry, () => config))
    this.saves = saved.catch(() => {})
    await saved
  }
}

export default AgentDefaultModelConfig
