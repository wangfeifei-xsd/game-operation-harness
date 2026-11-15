/** 单个 Host 代际的模型页面数据，过期请求不能恢复旧账号快照。 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelConfigInput, ModelConfigMutation, ModelConfigSnapshot, ModelConnectionResult } from '@deepseek-ai/dsh-harness-model-config/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** 页面资源状态，刷新失败时保留已显示数据。 */
export interface DirectPageState { data: ModelConfigSnapshot | null; loading: boolean; error: string | null; generation: number }
/** 组件可调用的纯业务函数。 */
export interface DirectOperations {
  load(): Promise<ModelConfigSnapshot | null>
  save(input: ModelConfigInput, revision: number): Promise<RemoteResult<ModelConfigSnapshot>>
  setDefault(request: ModelConfigMutation): Promise<RemoteResult<ModelConfigSnapshot>>
  setEnabled(request: ModelConfigMutation, enabled: boolean): Promise<RemoteResult<ModelConfigSnapshot>>
  remove(request: ModelConfigMutation): Promise<RemoteResult<ModelConfigSnapshot>>
  test(request: ModelConfigMutation): Promise<RemoteResult<ModelConnectionResult>>
  cancelTest(): void
}

/** 一个插件实例拥有的数据请求和变更结果发布器。 */
export class DirectModelsPage {
  /** 当前 Host 代际的页面快照与加载状态。 */
  readonly store = createSnapshotStore<DirectPageState>({ data: null, loading: false, error: null, generation: 0 })
  private generation = 0
  private loadId = 0
  private testAbort: AbortController | undefined
  constructor(private readonly ctx: Context, private readonly loadFailed: () => string) {}

  /** Host 切换立即清空，旧请求随后只能被丢弃。 */
  reset(): void {
    this.generation++; this.loadId++; this.testAbort?.abort()
    this.store.set({ data: null, loading: false, error: null, generation: this.generation })
  }
  /**
   * 刷新页面并保留失败前的可见数据。
   * @returns 当前代际的最新快照，失败或请求过期时为空。
   */
  async load(): Promise<ModelConfigSnapshot | null> {
    const generation = this.generation
    const id = ++this.loadId
    this.store.update((state) => { state.loading = true; state.error = null })
    try {
      const result = await this.ctx.remote.modelConfig.list()
      if (generation !== this.generation || id !== this.loadId) return null
      if (result.ok) this.accept(result.value)
      this.store.update((state) => { state.loading = false; state.error = result.ok ? null : result.error.message })
      return result.ok ? this.store.getSnapshot().data : null
    } catch (_error) {
      if (generation === this.generation && id === this.loadId) {
        this.store.update((state) => { state.loading = false; state.error = this.loadFailed() })
      }
      return null
    }
  }
  /**
   * 创建绑定当前实例的操作函数。
   * @returns 页面可调用的 Remote 操作。
   */
  operations(): DirectOperations {
    const commit = async (operation: () => Promise<RemoteResult<ModelConfigSnapshot>>) => {
      const generation = this.generation
      const result = await operation()
      if (generation === this.generation && result.ok) this.accept(result.value)
      return result
    }
    return {
      load: () => this.load(),
      save: (input, revision) => commit(() => this.ctx.remote.modelConfig.save(input, revision)),
      setDefault: request => commit(() => this.ctx.remote.modelConfig.setDefault(request)),
      setEnabled: (request, enabled) => commit(() => this.ctx.remote.modelConfig.setEnabled(request, enabled)),
      remove: request => commit(() => this.ctx.remote.modelConfig.removeModel(request)),
      test: async (request) => {
        this.testAbort?.abort()
        const generation = this.generation
        const abort = new AbortController()
        this.testAbort = abort
        const result = await this.ctx.remote.modelConfig.testConnection(request, abort.signal)
        if (generation !== this.generation && result.ok) return { ok: true, value: { ...result.value, status: 'stale', message: this.loadFailed() } }
        return result
      },
      cancelTest: () => { this.testAbort?.abort() },
    }
  }
  private accept(data: ModelConfigSnapshot): void {
    const previous = this.store.getSnapshot().data
    if (previous !== null && previous.revision > data.revision) return
    this.store.update((state) => { state.data = data })
  }
}
