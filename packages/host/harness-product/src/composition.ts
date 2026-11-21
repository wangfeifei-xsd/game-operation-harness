/** 在可扩展插件树中保留 Creativity 身份、账号目录和产品模型配置。 */
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { modelComposition } from './model-composition.ts'
import type { HarnessConfig } from './config.ts'

const disabled = new Set([
  'authentication-token', 'web-startup',
])

/**
 * 将部署文件作为可覆盖的默认值，保留插件原有的其余配置。
 * @param patches - 已选择的组合包补丁。
 * @param config - 环境文件中的部署默认值。
 * @param environment - 启动时捕获的扩展环境；重载时复用同一快照。
 * @returns 应用在用户补丁之前的组合包配置。
 */
export function harnessDefaults(
  patches: PatchOptions[], config: HarnessConfig, environment: Readonly<Record<string, string | undefined>>,
): PatchOptions[] {
  const entries = composeEntries([patches])
  for (const entry of entries) {
    const fields = entry.config as Record<string, unknown> | undefined
    if (entry.id === 'sandbox-policy') entry.config = { ...fields, mode: environment.DSH_PERMISSION_MODE ?? config.sandbox.mode }
    if (entry.id === 'approval') entry.config = { ...fields, policy: environment.DSH_PERMISSION_MODE === undefined
      ? config.sandbox.approval : environment.DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask' }
    if (entry.id === 'session-telemetry-otel') {
      entry.config = { ...fields, mode: environment.DSH_TELEMETRY_MODE || config.telemetry.mode,
        exporter: { ...fields?.exporter as object, url: environment.DSH_TELEMETRY_OTLP_URL ?? config.telemetry.url } }
      entry.disabled = !config.telemetry.enabled
    }
  }
  return [{ insert: entries }]
}

/**
 * 绑定账号持久化与私有入口，其他扩展和配置沿用用户组合。
 * @param patches - 组合包、用户配置和命令行覆盖补丁。
 * @param config - 已验证的环境文件。
 * @param home - 中央身份确定的独占账号目录。
 * @param modelHome - 模型只读配置来源。
 * @returns 已保留产品登录及模型改造的单次插入补丁。
 */
export function harnessComposition(patches: PatchOptions[], config: HarnessConfig, home: string, modelHome = home): PatchOptions[] {
  const entries = composeEntries([patches])
  const visit = (entry: EntryOptions): void => {
    if (disabled.has(entry.id)) entry.disabled = true
    const value: unknown = entry.config
    if (Array.isArray(value)) value.forEach(visit)
    const fields = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
    if (Array.isArray(fields.plugins)) fields.plugins.forEach(visit)
    const replace = (next: Record<string, unknown>): void => { entry.config = next }
    switch (entry.id) {
      case 'ui-brand-game-operation': replace({ productAccount: true }); break
      case 'session-persistence-jsonl': replace({ root: join(home, 'sessions') }); break
      case 'storage-json': replace({ root: join(home, 'storages') }); break
      case 'credentials': replace({ dshHome: home, deploymentCredentials: config.providers.credentials }); break
      case 'shell-env': case 'attachment-local': replace({ ...fields, dshHome: home }); break
      case 'command-feedback': replace({ ...fields, dshHome: home }); break
      case 'web-search-deepseek': replace({ ...fields, baseURL: config.providers.searchBaseUrl }); break
      case 'web-deepseek-api': replace({ ...fields, searchBaseURL: config.providers.searchBaseUrl, fetchBaseURL: config.providers.searchBaseUrl }); break
      case 'webserver': replace({ host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 }); break
      case 'web-runtime': replace({ ...fields, openBrowser: false, printUrl: false }); break
      case 'session-telemetry-otel':
        replace({ ...fields, dshHome: home })
        break
      default: break
    }
  }
  entries.forEach(visit)
  return modelComposition([{ insert: entries }], home, modelHome)
}
