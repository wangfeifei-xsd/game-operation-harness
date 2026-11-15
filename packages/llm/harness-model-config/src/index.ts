/** 当前 Host 独占的产品模型配置、凭据提交与运行路由。 */
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialKey, credentialKeyScope, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { LlmError, normalizeApiKey, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles, probeEndpointModels } from '@deepseek-ai/dsh-llm-pi-ai/model-config'
import type { ResolvedPiAiProviderProfile, PiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import { StorageError, type KvUnit } from '@deepseek-ai/dsh-storage'
import { InvalidModelField, modelFields, modelHints, modelMetadata, providers } from './providers.ts'
import type { HarnessModelId, ModelConfigInput, ModelConfigMutation, ModelConfigSnapshot, ModelConnectionResult } from './types.ts'

export type * from './types.ts'
export type { HarnessModelConfig }

const SCOPE = 'harness-model-config'
const idSchema = schema.uuid().transform(value => brandString<HarnessModelId>(value))
const recordSchema = modelFields.extend({ id: idSchema, enabled: schema.boolean(), credential: schema.string().startsWith(`${SCOPE}/`) }).strict()
const snapshotSchema = schema.object({ revision: schema.number().int().nonnegative(), models: schema.array(recordSchema), defaultId: idSchema.nullable(), defaultReasoningEffort: schema.string().optional(), cleanup: schema.array(schema.string().startsWith(`${SCOPE}/`)) }).strict()
type StoredSnapshot = schema.infer<typeof snapshotSchema>
type StoredModel = schema.infer<typeof recordSchema>
type PendingKey = { key: CredentialKey; value: string }

/** 稳定错误类型；消息和字段可以安全显示，永不包含 Key 或供应商响应正文。 */
export class ModelConfigError extends HarnessError {
  constructor(message: string, code: 'MODEL_CONFIG_INVALID' | 'MODEL_CONFIG_CONFLICT' | 'MODEL_CONFIG_NOT_FOUND' | 'MODEL_CONFIG_STORAGE' | 'MODEL_CONFIG_CLOSED', readonly field?: string) {
    super(message, code)
  }
}

/** Cordis 模型服务装配配置。 */
export interface Config {
  /** 入口已解析并验证的模型存储根。 */
  root: string
}
/** 显式传入已验证 Host 作用域，禁止从 UI 或供应商账号推导。 */
export const Config: z<Config> = z.object({ root: z.string().required() })
export const name = SCOPE
export const inject = ['storage', 'storage.backend.json', 'credentials', 'llm', 'agentDefaultModel']

declare module '@deepseek-ai/cordis' {
  interface Context { harnessModelConfig: HarnessModelConfig }
}

/**
 * 在取得生命周期文件锁之后打开模型单元；服务就绪才提供给 Remote。
 * @param ctx - 已按产品身份隔离的 Host。
 * @param config - 该 Host 的存储根。
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  await mkdir(config.root, { recursive: true, mode: 0o700 })
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const ownership = withFileLock(join(config.root, 'harness_models.owner'), async () => {
    const kv = ctx.storage.backend.get('json').kv
    if (kv === undefined) throw new ModelConfigError('模型存储不可用', 'MODEL_CONFIG_STORAGE')
    const unit = await kv.open({ name: 'harness_models', version: 1, layout: 'single', tables: [], hasGlobal: true })
    const service = new HarnessModelConfig(ctx, unit)
    try {
      await service.initialize()
      ctx.provide('harnessModelConfig', service)
      ctx.effect(() => ctx.agentDefaultModel.registerSource({
        read: () => service.defaultSelection(), save: next => service.saveDefaultSelection(next),
      }))
      ready.resolve()
      await release.promise
    } finally { await service.close() }
  }, { waitMs: 0 })
  void ownership.catch((error: unknown) => { ready.reject(error) })
  ctx.effect(() => async () => { release.resolve(); await ownership }, '模型配置：独占写入和退出等待')
  await ready.promise
}

/** 每个已解析数据根只有一个实例，所有修改进入同一队列。 */
class HarnessModelConfig {
  private state: StoredSnapshot = { revision: 0, models: [], defaultId: null, cleanup: [] }
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private closing = false
  private unhealthy = false
  private profiles = new Map<string, ResolvedPiAiProviderProfile>()
  private registration: AdapterRegistrationHandle | undefined
  private runtimeError: string | null = null
  private cleanupPending = false
  private readonly tests = new Set<AbortController>()
  private readonly testTasks = new Set<Promise<ModelConnectionResult>>()
  private readonly credentialKeys = new WeakMap<ResolvedPiAiProviderProfile, CredentialKey>()
  private readonly adapter: PiAiAdapter

  constructor(private readonly ctx: Context, private readonly unit: KvUnit) {
    this.adapter = new PiAiAdapter({
      profiles: () => { this.assertAccepting(); return this.profiles },
      resolveApiKey: async (route, profile) => {
        this.assertAccepting()
        if (this.profiles.get(route) !== profile) throw new LlmError('模型配置已变化，请重新选择', 'UNKNOWN_MODEL')
        const key = this.credentialKeys.get(profile)
        if (key === undefined) throw new LlmError('请重新配置模型密钥', 'MISSING_CREDENTIAL')
        const record = await this.ctx.credentials.readRecord(key)
        if (record?.kind !== 'api-key' || !record.key || !normalizeApiKey(record.key).ok) throw new LlmError('模型密钥缺失，请重新配置', 'MISSING_CREDENTIAL')
        if (this.profiles.get(route) !== profile) throw new LlmError('模型配置已变化，请重新选择', 'UNKNOWN_MODEL')
        return record.key
      },
      auth: {
        credentials: { delete: () => Promise.resolve(), read: () => Promise.resolve(undefined), list: () => Promise.resolve([]), modify: () => Promise.reject(new LlmError('产品模型仅支持 API Key 配置', 'MISSING_CREDENTIAL')) },
        authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
      },
      resolveAttachments: () => ctx.get('attachments'),
      resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, path => ctx.get('fs')?.processPathFromHostPath(path), ref),
    })
  }

  /** 从唯一配置快照恢复；损坏数据不会被空数据覆盖。 */
  async initialize(): Promise<void> {
    const saved = (await this.unit.loadAll()).global
    if (saved !== null) {
      const parsed = snapshotSchema.safeParse(saved)
      if (!parsed.success) throw new ModelConfigError('模型配置文件损坏，请检查存储文件', 'MODEL_CONFIG_STORAGE')
      this.state = parsed.data
    }
    this.validateSnapshot(this.state)
    this.publish(this.buildProfiles(this.state))
    await this.cleanup()
  }

  /**
   * 一次读取页面所需字段，凭据仅返回是否存在。
   * @returns 不含密钥和凭据地址的页面快照。
   */
  async list(): Promise<ModelConfigSnapshot> {
    this.assertAccepting()
    return this.snapshot()
  }

  private async snapshot(): Promise<ModelConfigSnapshot> {
    const state = this.state
    // 凭据服务内存读取不再解析文件；一次收集当前模型的有效性，不把空记录当作可调用 Key。
    const configured = new Map(await Promise.all(state.models.map(async (model) => {
      const record = await this.ctx.credentials.readRecord(parseCredentialKey(model.credential))
      return [model.id, record?.kind === 'api-key' && record.key !== undefined && normalizeApiKey(record.key).ok] as const
    })))
    return {
      revision: state.revision, providers: structuredClone(providers), modelHints: modelHints(), defaultId: state.defaultId,
      cleanupPending: this.cleanupPending, runtimeError: this.runtimeError,
      models: state.models.map(({ credential: _credential, ...model }) => {
        const meta = modelMetadata(model)
        return { ...model, credentialConfigured: configured.get(model.id) === true,
          effectiveContextWindow: meta.contextWindow, effectiveMaxOutputTokens: meta.maxTokens, reasoningEfforts: meta.efforts }
      }),
    }
  }

  /**
   * 新建或编辑模型，配置持久化成功后才发布。
   * @param input - 表单完整值；编辑时省略 Key 表示保留。
   * @param expectedRevision - 页面读取到的修订。
   * @returns 提交后的快照及清理状态。
   */
  save(input: ModelConfigInput, expectedRevision: number): Promise<ModelConfigSnapshot> {
    input = structuredClone(input)
    return this.mutate(expectedRevision, (candidate) => {
      const parsed = modelFields.safeParse(input)
      if (!parsed.success) {
        throw new ModelConfigError('请检查模型字段', 'MODEL_CONFIG_INVALID', String(parsed.error.issues[0]?.path[0] ?? 'name'))
      }
      const fields = parsed.data
      const existing = input.id === undefined ? undefined : this.find(input.id)
      this.validateFields(fields)
      if (candidate.models.some(item => item.id !== existing?.id && item.name === fields.name)) throw new ModelConfigError('模型名称已存在', 'MODEL_CONFIG_INVALID', 'name')
      const changedOrigin = existing !== undefined && (existing.providerKey !== fields.providerKey
        || new URL(existing.baseUrl).origin !== new URL(fields.baseUrl).origin)
      const supplied = input.apiKey?.trim()
      if ((!existing || changedOrigin) && !supplied) throw new ModelConfigError('请填写 API Key', 'MODEL_CONFIG_INVALID', 'apiKey')
      let credential = existing?.credential
      const pending: PendingKey[] = []
      if (supplied) {
        const normalized = normalizeApiKey(supplied)
        if (!normalized.ok) throw new ModelConfigError('API Key 格式无效', 'MODEL_CONFIG_INVALID', 'apiKey')
        credential = String(credentialKey(SCOPE, `key-${randomUUID()}`))
        pending.push({ key: parseCredentialKey(credential), value: normalized.value })
      }
      if (credential === undefined) throw new ModelConfigError('请填写 API Key', 'MODEL_CONFIG_INVALID', 'apiKey')
      const model = { ...fields, id: existing?.id ?? brandString<HarnessModelId>(randomUUID()),
        credential, enabled: existing?.enabled ?? true }
      if (existing) candidate.models = candidate.models.map(item => item.id === model.id ? model : item)
      else candidate.models.push(model)
      if (existing && credential !== existing.credential) candidate.cleanup.push(existing.credential)
      if (candidate.defaultId === null && model.enabled) candidate.defaultId = model.id
      if (candidate.defaultId === model.id && !modelMetadata(model).efforts.some(effort => effort === candidate.defaultReasoningEffort)) {
        delete candidate.defaultReasoningEffort
      }
      return pending
    })
  }

  /**
   * 修改启用状态，停用默认模型须在同次变更选择替代。
   * @param request - 条件变更与可选替代模型。
   * @param enabled - 新启用状态。
   * @returns 提交后的完整快照。
   */
  setEnabled(request: ModelConfigMutation, enabled: boolean): Promise<ModelConfigSnapshot> {
    request = structuredClone(request)
    return this.mutate(request.expectedRevision, (candidate) => {
      this.find(request.id)
      candidate.models = candidate.models.map(model => model.id === request.id ? { ...model, enabled } : model)
      this.replaceDefault(candidate, request)
      if (candidate.defaultId === null && enabled) candidate.defaultId = request.id
      return []
    })
  }

  /**
   * 删除配置并在提交后清理独占凭据。
   * @param request - 条件删除与可选替代默认模型。
   * @returns 提交后的完整快照。
   */
  remove(request: ModelConfigMutation): Promise<ModelConfigSnapshot> {
    request = structuredClone(request)
    return this.mutate(request.expectedRevision, (candidate) => {
      const model = this.find(request.id)
      candidate.models = candidate.models.filter(item => item.id !== request.id)
      candidate.cleanup.push(model.credential)
      this.replaceDefault(candidate, request)
      return []
    })
  }

  /**
   * 设置后续会话的默认模型。
   * @param request - 条件设置请求。
   * @returns 提交后的完整快照。
   */
  setDefault(request: ModelConfigMutation): Promise<ModelConfigSnapshot> {
    request = structuredClone(request)
    return this.mutate(request.expectedRevision, (candidate) => {
      if (!this.find(request.id).enabled) throw new ModelConfigError('停用模型不能设为默认', 'MODEL_CONFIG_INVALID')
      candidate.defaultId = request.id
      delete candidate.defaultReasoningEffort
      return []
    })
  }

  /**
   * 读取唯一默认来源，空配置返回空。
   * @returns 当前有效默认选择。
   */
  defaultSelection(): ModelSelection | null {
    this.assertAccepting()
    const model = this.state.models.find(item => item.id === this.state.defaultId && item.enabled)
    return model === undefined ? null : { provider: this.route(model.id), model: model.model,
      ...this.state.defaultReasoningEffort === undefined ? {} : {
        reasoningEffort: brandString<ReasoningEffortId>(this.state.defaultReasoningEffort),
      } }
  }

  /**
   * 聊天手工选择后保存同一业务默认值，不依赖 profile 编辑器。
   * @param selection - 经过 Host 目录校验的选择。
   */
  async saveDefaultSelection(selection: ModelSelection): Promise<void> {
    selection = structuredClone(selection)
    await this.mutate(undefined, (candidate) => {
      const model = candidate.models.find(item => this.route(item.id) === selection.provider
        && item.model === selection.model && item.enabled)
      if (model === undefined) throw new ModelConfigError('模型不可用，请重新选择', 'MODEL_CONFIG_NOT_FOUND')
      if (selection.reasoningEffort !== undefined && !modelMetadata(model).efforts.some(effort => effort === selection.reasoningEffort)) {
        throw new ModelConfigError('推理强度不可用', 'MODEL_CONFIG_INVALID')
      }
      candidate.defaultId = model.id
      if (selection.reasoningEffort === undefined) delete candidate.defaultReasoningEffort
      else candidate.defaultReasoningEffort = selection.reasoningEffort
      return []
    })
  }

  /**
   * 发起真实目录网络请求，不使用本地目录冒充网络成功。
   * @param request - 已保存模型及所读修订。
   * @param signal - 可选的取消信号。
   * @returns 连接状态、耗时和 UTC 检查时间。
   */
  testConnection(request: ModelConfigMutation, signal?: AbortSignal): Promise<ModelConnectionResult> {
    this.assertAccepting()
    this.checkRevision(request.expectedRevision)
    const model = this.find(request.id)
    const abort = new AbortController()
    this.tests.add(abort)
    const cancel = () => { abort.abort() }
    if (signal?.aborted) cancel()
    signal?.addEventListener('abort', cancel, { once: true })
    const task = this.probe(model, request.expectedRevision, abort)
    this.testTasks.add(task)
    void task.finally(() => { this.tests.delete(abort); this.testTasks.delete(task); signal?.removeEventListener('abort', cancel) }).catch(() => undefined)
    return task
  }

  /** 等待修改和检查结束后关闭单元；退出后拒绝新请求。 */
  async close(): Promise<void> {
    this.closing = true
    for (const test of this.tests) test.abort()
    await Promise.allSettled([...this.testTasks])
    await this.queue
    this.closed = true
    this.registration?.()
    await this.unit.close()
  }

  private route(id: HarnessModelId): string { return `harness-model-${id}` }
  private assertOpen(): void {
    if (this.closed || this.unhealthy) throw new ModelConfigError(this.unhealthy ? '模型存储状态不确定，请重新启动 Host' : '模型服务已关闭', this.unhealthy ? 'MODEL_CONFIG_STORAGE' : 'MODEL_CONFIG_CLOSED')
  }
  private assertAccepting(): void {
    this.assertOpen()
    if (this.closing) throw new ModelConfigError('模型服务正在退出', 'MODEL_CONFIG_CLOSED')
  }
  private checkRevision(revision: number | undefined): void {
    if (revision !== undefined && revision !== this.state.revision) throw new ModelConfigError('模型配置已被其他窗口修改，请重新加载', 'MODEL_CONFIG_CONFLICT')
  }
  private find(id: HarnessModelId): StoredModel {
    const model = this.state.models.find(item => item.id === id)
    if (model === undefined) throw new ModelConfigError('模型已不存在，请重新加载', 'MODEL_CONFIG_NOT_FOUND')
    return model
  }
  private validateFields(fields: Omit<ModelConfigInput, 'id' | 'apiKey'>): void {
    let url: URL
    try { url = new URL(fields.baseUrl) } catch (_error) { throw new ModelConfigError('请输入完整 HTTP(S) 接口地址', 'MODEL_CONFIG_INVALID', 'baseUrl') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelConfigError('接口地址不能包含认证信息、查询参数或片段', 'MODEL_CONFIG_INVALID', 'baseUrl')
    try { modelMetadata(fields) } catch (error) {
      if (error instanceof InvalidModelField) throw new ModelConfigError(error.message, 'MODEL_CONFIG_INVALID', error.field)
      throw error
    }
  }
  private validateSnapshot(state: StoredSnapshot): void {
    const names = new Set<string>()
    const ids = new Set<string>()
    const credentials = new Set<string>()
    for (const model of state.models) {
      this.validateFields(model)
      parseCredentialKey(model.credential)
      if (names.has(model.name) || ids.has(model.id) || credentials.has(model.credential)) throw new ModelConfigError('模型配置存在重复记录', 'MODEL_CONFIG_STORAGE')
      names.add(model.name); ids.add(model.id); credentials.add(model.credential)
    }
    for (const key of state.cleanup) parseCredentialKey(key)
    if (state.defaultId !== null && !state.models.some(item => item.id === state.defaultId && item.enabled)) {
      throw new ModelConfigError('默认模型引用无效', 'MODEL_CONFIG_STORAGE')
    }
    const defaultModel = state.models.find(model => model.id === state.defaultId)
    if (state.defaultReasoningEffort !== undefined && (defaultModel === undefined || !modelMetadata(defaultModel).efforts.some(effort => effort === state.defaultReasoningEffort))) throw new ModelConfigError('默认推理强度无效', 'MODEL_CONFIG_STORAGE')
  }
  private buildProfiles(state: StoredSnapshot): Map<string, ResolvedPiAiProviderProfile> {
    const raw: Record<string, PiAiProviderProfile> = {}
    for (const model of state.models) {
      const meta = modelMetadata(model)
      if (!model.enabled) continue
      raw[this.route(model.id)] = {
        displayName: meta.provider.name,
        ...meta.catalog === undefined || meta.provider.catalogProvider === undefined ? {}
          : { catalogProvider: meta.provider.catalogProvider },
        // Anthropic SDK 自行追加 /v1/messages；仅去掉末尾版本段，保留网关路径。
        api: model.protocol,
        baseURL: model.protocol === 'anthropic-messages'
          ? model.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') : model.baseUrl.replace(/\/+$/, ''),
        timeoutMs: model.timeoutSeconds * 1000,
        defaultContextWindow: meta.contextWindow, defaultMaxTokens: meta.maxTokens,
        models: [{ id: model.model, name: model.name, contextWindow: meta.contextWindow,
          input: model.imageInput ? ['text', 'image'] : ['text'],
          ...model.maxOutputTokens === undefined ? {} : { maxTokens: model.maxOutputTokens } }],
        ...model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort },
      }
    }
    const profiles = resolveProfiles(raw)
    for (const model of state.models) {
      const profile = profiles.get(this.route(model.id))
      if (profile !== undefined) this.credentialKeys.set(profile, parseCredentialKey(model.credential))
    }
    return profiles
  }
  private publish(profiles: Map<string, ResolvedPiAiProviderProfile>): void {
    this.profiles = profiles
    try {
      if (this.registration === undefined && profiles.size === 0) { this.runtimeError = null; return }
      if (this.registration) this.registration.replace([...profiles.keys()])
      else this.registration = this.ctx.llm.registerAdapter([...profiles.keys()], this.adapter)
      this.runtimeError = null
    } catch (_error) { this.profiles = new Map(); this.runtimeError = '配置已保存，模型加载失败，请重新启动 Host' }
  }
  private replaceDefault(candidate: StoredSnapshot, request: ModelConfigMutation): void {
    if (candidate.defaultId !== request.id || candidate.models.some(item => item.id === request.id && item.enabled)) return
    const available = candidate.models.filter(item => item.enabled)
    if (available.length > 0 && !available.some(item => item.id === request.replacementDefaultId)) throw new ModelConfigError('请选择替代默认模型', 'MODEL_CONFIG_INVALID', 'replacementDefaultId')
    candidate.defaultId = available.length === 0 ? null : request.replacementDefaultId ?? null
    delete candidate.defaultReasoningEffort
  }
  private mutate(revision: number | undefined, prepare: (candidate: StoredSnapshot) => PendingKey[]): Promise<ModelConfigSnapshot> {
    this.assertAccepting()
    const operation = this.queue.then(async () => {
      this.assertOpen(); this.checkRevision(revision)
      const candidate = structuredClone(this.state)
      let created: CredentialKey[] = []
      try {
        const pending = prepare(candidate)
        candidate.revision++
        this.validateSnapshot(candidate)
        const profiles = this.buildProfiles(candidate)
        created = pending.map(item => item.key)
        for (const { key, value } of pending) await this.ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'api-key', key: value }))
        try { await this.unit.setGlobal(candidate) }
        catch (error) {
          if (error instanceof StorageError && error.code === 'unknown-state') this.unhealthy = true
          throw new ModelConfigError('模型配置保存失败，请重新加载后重试', 'MODEL_CONFIG_STORAGE')
        }
        this.state = candidate
        this.publish(profiles)
      } catch (error) {
        if (!this.unhealthy) for (const key of created) {
          try { await this.ctx.credentials.deleteRecord(key) } catch (_cleanupError) { this.cleanupPending = true }
        }
        throw error
      }
      const listeners = this.ctx.events.dispatch('emit', ['model-config/changed', candidate.revision]) as
        Array<(revision: number) => void | Promise<void>>
      for (const listener of listeners) {
        try { void Promise.resolve(listener(candidate.revision)).catch(() => { this.ctx.logger.warn('模型配置已提交，通知订阅者失败') }) }
        catch (_error) { this.ctx.logger.warn('模型配置已提交，通知订阅者失败') }
      }
      await this.cleanup()
      try { return await this.snapshot() }
      catch (_error) {
        // 提交已完成；读取凭据状态失败不能向调用者谎报保存失败。
        return { revision: candidate.revision, providers: structuredClone(providers),
          modelHints: modelHints(), defaultId: candidate.defaultId,
          cleanupPending: this.cleanupPending, runtimeError: this.runtimeError ?? '配置已保存，密钥状态读取失败，请重新加载',
          models: candidate.models.map(({ credential: _credential, ...model }) => {
            const meta = modelMetadata(model)
            return { ...model, credentialConfigured: false,
              effectiveContextWindow: meta.contextWindow, effectiveMaxOutputTokens: meta.maxTokens, reasoningEfforts: meta.efforts }
          }) }
      }
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }
  private async cleanup(): Promise<void> {
    const referenced = new Set(this.state.models.map(model => model.credential))
    this.cleanupPending = false
    const pending = new Set<string>()
    try {
      for (const record of await this.ctx.credentials.listRecords()) {
        if (credentialKeyScope(record.key) !== SCOPE || referenced.has(String(record.key))) continue
        try { await this.ctx.credentials.deleteRecord(record.key) }
        catch (_error) { this.cleanupPending = true; pending.add(String(record.key)) }
      }
      this.state.cleanup = [...pending]
    } catch (_error) { this.cleanupPending = true }
  }
  private async probe(model: StoredModel, revision: number, abort: AbortController): Promise<ModelConnectionResult> {
    const start = performance.now()
    const timer = setTimeout(() => { abort.abort() }, Math.min(model.timeoutSeconds * 1000, 15000))
    let status: ModelConnectionResult['status'] = 'connected'
    let message = '连接成功'
    try {
      const record = await this.ctx.credentials.readRecord(parseCredentialKey(model.credential))
      if (record?.kind !== 'api-key' || !record.key) throw new LlmError('模型密钥缺失', 'MISSING_CREDENTIAL')
      await probeEndpointModels({ baseURL: model.baseUrl, api: model.protocol, apiKey: record.key, signal: abort.signal })
    } catch (error) {
      status = error instanceof LlmError && error.code === 'DISCOVERY_UNSUPPORTED' ? 'unsupported' : 'failed'
      message = status === 'unsupported' ? '供应商不支持模型目录检查'
        : abort.signal.aborted ? '连接检查超时或已取消'
          : error instanceof LlmError && (error.code === 'HTTP_401' || error.code === 'HTTP_403') ? 'API Key 验证失败，请检查密钥和访问权限'
            : error instanceof LlmError && error.code === 'TRANSPORT' ? '无法连接供应商，请检查地址、网络和证书'
              : error instanceof LlmError && error.code === 'MISSING_CREDENTIAL' ? '模型密钥缺失，请重新配置'
                : '连接检查失败，供应商未返回可用模型目录'
    } finally { clearTimeout(timer) }
    if (revision !== this.state.revision || this.closed) { status = 'stale'; message = '配置已变化，请重新检查' }
    return { revision, status, message, elapsedMs: Math.round(performance.now() - start), checkedAt: new Date().toISOString() }
  }
}
