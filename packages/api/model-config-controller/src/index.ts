/** 模型配置的薄 Remote 控制器；业务校验、并发及存储由服务负责。 */
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ModelConfigError } from '@deepseek-ai/dsh-harness-model-config'
import type { ModelConfigInput, ModelConfigMutation, ModelConfigSnapshot,
  ModelConnectionResult } from '@deepseek-ai/dsh-harness-model-config/types'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { modelConfigController: ModelConfigController }
}


/** 当前认证 Host 内的模型配置接口；未授权访问继续由 Gateway 拒绝。 */
export class ModelConfigController extends TypertRemoteService {
  static inject = ['harnessModelConfig']
  constructor(ctx: Context) { super(ctx, 'modelConfigController', { namespace: 'modelConfig' }) }

  /**
   * 读取当前 Host 的模型页面。
   * @returns 不含密钥的页面快照。
   */
  @Remote
  list(): Promise<ModelConfigSnapshot> { return this.run(() => this.ctx.harnessModelConfig.list()) }

  /**
   * 提交一条完整模型配置。
   * @param input - 完整表单，密钥只允许输入。
   * @param expectedRevision - 页面读取修订。
   * @returns 已提交页面快照。
   */
  @Remote
  save(input: ModelConfigInput, expectedRevision: number): Promise<ModelConfigSnapshot> {
    return this.run(() => this.ctx.harnessModelConfig.save(input, expectedRevision))
  }

  /**
   * 修改模型启用状态。
   * @param request - 模型及修订、可选替代默认模型。
   * @param enabled - 新启用状态。
   * @returns 已提交页面快照。
   */
  @Remote
  setEnabled(request: ModelConfigMutation, enabled: boolean): Promise<ModelConfigSnapshot> {
    return this.run(() => this.ctx.harnessModelConfig.setEnabled(request, enabled))
  }

  /**
   * 选择后续会话的默认模型。
   * @param request - 模型及页面修订。
   * @returns 已提交页面快照。
   */
  @Remote
  setDefault(request: ModelConfigMutation): Promise<ModelConfigSnapshot> {
    return this.run(() => this.ctx.harnessModelConfig.setDefault(request))
  }

  /**
   * 删除模型及其独占凭据引用。
   * @param request - 模型及修订、可选替代默认模型。
   * @returns 已提交页面快照。
   */
  @Remote
  removeModel(request: ModelConfigMutation): Promise<ModelConfigSnapshot> {
    return this.run(() => this.ctx.harnessModelConfig.remove(request))
  }

  /**
   * 检查已保存端点的模型目录。
   * @param request - 保存后的模型及页面修订。
   * @param signal - 客户端取消与连接断开信号。
   * @returns 真实网络连接检查结果。
   */
  @Remote
  testConnection(request: ModelConfigMutation, signal: AbortSignal): Promise<ModelConnectionResult> {
    return this.run(() => this.ctx.harnessModelConfig.testConnection(request, signal))
  }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) {
      if (error instanceof ModelConfigError) throw new RemoteError('model-config/rejected', error.message,
        { reason: error.code, field: error.field ?? null })
      throw new RemoteError('gateway/internal', '模型配置操作失败，请重试', {})
    }
  }
}
export default ModelConfigController
