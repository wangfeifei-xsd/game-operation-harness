/** 固定插件树的偏好文件，仅保存允许条目的即时字段。 */
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { FiberState } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { HarnessError } from '@deepseek-ai/dsh-error'
import { isPlainObject, mergeLayers } from './layers.ts'
import { isVolatilePath, projectForm, volatileForm } from './schema.ts'

class PreferencesError extends HarnessError {
  constructor(message: string, code: 'SETTINGS_PREFERENCES_INVALID' | 'SETTINGS_PREFERENCES_STORAGE', cause?: unknown) {
    super(message, code, { cause })
  }
}

/** 账号隔离的偏好存储；不解析或重载 Cordis 补丁。 */
export class Preferences {
  private readonly saved: Record<string, Record<string, unknown>>
  private readonly bases = new Map<Entry, Record<string, unknown>>()
  private tail: Promise<void> = Promise.resolve()
  private closed = false

  /**
   * @param ctx - 设置服务所属的固定运行树。
   * @param documentPath - 入口确定的账号偏好文件。
   * @param namespaces - 允许修改的条目集合。
   */
  constructor(private readonly ctx: Context, readonly documentPath: string, private readonly namespaces: readonly string[]) {
    let value: unknown = {}
    try { value = JSON.parse(readFileSync(documentPath, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PreferencesError('偏好文件读取失败，请检查账号偏好文件后重新启动', 'SETTINGS_PREFERENCES_STORAGE', error)
      }
    }
    if (!isPlainObject(value) || Object.entries(value).some(([ns, section]) => !this.canWrite(ns) || !isPlainObject(section))) {
      throw new PreferencesError('偏好文件包含不允许的配置，请检查后重新启动', 'SETTINGS_PREFERENCES_INVALID')
    }
    this.saved = value as Record<string, Record<string, unknown>>
  }

  /** 判断条目是否允许保存偏好。
   * @param ns - 插件条目名称。
   * @returns 是否属于入口声明的偏好范围。
   */
  canWrite(ns: string): boolean { return this.namespaces.includes(ns) }

  /** 读取可唯一定位的活动条目。
   * @returns 固定运行树中的条目。
   */
  entries(): Entry[] {
    const entries = [...this.ctx.loader.entries()].filter(entry => entry.parent.tree.ctx.fiber.entry?.id === 'include')
    const counts = new Map<string, number>()
    for (const entry of entries) counts.set(entry.options.id, (counts.get(entry.options.id) ?? 0) + 1)
    return entries.filter(entry => counts.get(entry.options.id) === 1)
  }

  /** 按即时字段校验并恢复偏好；调用方须等待 Loader 完成启动。
   * @returns 所有已保存字段应用完成。
   */
  async initialize(): Promise<void> {
    for (const entry of this.entries()) {
      if (this.closed) return
      const base = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
      this.bases.set(entry, base)
      const override = this.saved[entry.options.id]
      if (override === undefined) continue
      this.validate(entry, override)
      const next = mergeLayers(base, override) as Record<string, unknown>
      const fiber = entry.fiber
      if (fiber?.state !== FiberState.ACTIVE) {
        throw new PreferencesError('偏好条目不可用，请检查账号偏好文件', 'SETTINGS_PREFERENCES_INVALID')
      }
      fiber.resolveConfig(next)
      await entry.update({ config: next })
    }
  }

  /** 读取运行值对应的继承层与账号覆盖层。
   * @returns 与编辑器相同的字段视图。
   */
  configuration(): Array<{ entry: Entry; inherited: Record<string, unknown>; override: Record<string, unknown> }> {
    return this.entries().map(entry => ({
      entry,
      inherited: structuredClone(this.bases.get(entry) ?? (entry.options.config ?? {}) as Record<string, unknown>),
      override: structuredClone(this.saved[entry.options.id] ?? {}),
    }))
  }

  /** 串行校验、落盘并更新即时引用；写盘失败保持运行值不变。
   * @param entry - 本次编辑的活动条目。
   * @param change - 在锁内依据当前值计算候选配置，同时校验修订号。
   * @returns 持久化及即时更新完成。
   */
  edit(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    const operation = this.tail.then(() => this.write(entry, change))
    this.tail = operation.then(() => {}, () => {})
    return operation
  }

  /** 停止排队写入，并等待已开始的持久化操作退出。
   * @returns 当前写入完成。
   */
  async close(): Promise<void> {
    this.closed = true
    await this.tail
  }

  private async write(
    entry: Entry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void> {
    await mkdir(dirname(this.documentPath), { recursive: true, mode: 0o700 })
    await withFileLock(this.documentPath, async () => {
      const fiber = entry.fiber
      if (this.closed || !this.canWrite(entry.options.id) || !this.entries().includes(entry) || fiber?.state !== FiberState.ACTIVE) {
        throw new PreferencesError('此配置由部署管理，不能作为个人偏好修改', 'SETTINGS_PREFERENCES_INVALID')
      }
      const current = structuredClone((entry.options.config ?? {}) as Record<string, unknown>)
      const base = structuredClone(this.bases.get(entry) ?? current)
      const next = change(current, base)
      const schema = this.validate(entry, {})
      const form = volatileForm(schema)
      if (form === undefined) {
        throw new PreferencesError('此配置没有可保存的即时字段', 'SETTINGS_PREFERENCES_INVALID')
      }
      const override = projectForm(form, next) as Record<string, unknown>
      this.validate(entry, override)
      fiber.resolveConfig(next)
      const saved = { ...this.saved, [entry.options.id]: override }
      try { await writeFileAtomic(this.documentPath, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 }) }
      catch (error) { throw new PreferencesError('偏好保存失败，请重试', 'SETTINGS_PREFERENCES_STORAGE', error) }
      Object.assign(this.saved, saved)
      await entry.update({ config: next })
    })
  }

  private validate(entry: Entry, section: Record<string, unknown>): z {
    const schema = entry.fiber?.runtime?.Config as z | undefined
    if (schema === undefined || !this.canWrite(entry.options.id)) {
      throw new PreferencesError('偏好条目不可用，请检查账号偏好文件', 'SETTINGS_PREFERENCES_INVALID')
    }
    const visit = (value: Record<string, unknown>, path: string[]): void => {
      for (const [key, child] of Object.entries(value)) {
        const target = [...path, key]
        if (isVolatilePath(schema, target)) continue
        if (isPlainObject(child) && Object.keys(child).length > 0) visit(child, target)
        else throw new PreferencesError('偏好文件包含非即时配置字段', 'SETTINGS_PREFERENCES_INVALID')
      }
    }
    visit(section, [])
    return schema
  }
}
