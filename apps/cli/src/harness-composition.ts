/** 将安装包的固定插件树装配到经过认证的账号目录。 */
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { HarnessConfig } from './harness-config.ts'

const disabled = new Set([
  'authentication-token', 'web-startup', 'harness-dev-context', 'hmr', 'client-hmr',
  'plugin-manager', 'tool-plugin-manager', 'config-editor', 'tool-cordis', 'ui-cordis',
  'ui-plugin-manager', 'ui-settings-plugins', 'ui-settings-plugin-inventory',
  'cordis-inspect-providers', 'cordis-host-runner', 'cordis-client-runner',
  'desktop-product-telemetry', 'product-analytics',
])

/**
 * 替换持久化路径及部署配置，包括 Agent preset 内的技能与指令插件。
 * @param patches - 安装包提供的补丁；不会读取用户或项目补丁。
 * @param config - 已验证的环境文件。
 * @param home - 中央身份确定的独占账号目录。
 * @returns 固定产品树的单次插入补丁。
 */
export function harnessComposition(patches: PatchOptions[], config: HarnessConfig, home: string): PatchOptions[] {
  const entries = composeEntries([patches])
  const visit = (entry: EntryOptions): void => {
    if (disabled.has(entry.id)) entry.disabled = true
    const value: unknown = entry.config
    if (Array.isArray(value)) value.forEach(visit)
    const fields = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
    if (Array.isArray(fields.plugins)) fields.plugins.forEach(visit)
    const replace = (next: Record<string, unknown>): void => { entry.config = next }
    switch (entry.id) {
      case 'preset-cordis': entry.disabled = true; break
      case 'session-persistence-jsonl': replace({ root: join(home, 'sessions') }); break
      case 'storage-json': replace({ root: join(home, 'storages') }); break
      case 'credentials': replace({ dshHome: home, deploymentCredentials: config.providers.credentials }); break
      case 'shell-env': case 'attachment-local': replace({ ...fields, dshHome: home }); break
      case 'agent-instructions': case 'skill-filesystem':
        replace({ ...fields, dshHome: home, agentsHome: join(home, 'agents') }); break
      case 'command-feedback': replace({ ...fields, dshHome: home }); break
      case 'llm-deepseek': replace({ ...fields, baseURL: config.providers.deepseekBaseUrl }); break
      case 'llm-deepseek-account': replace({ ...fields, baseURL: config.providers.accountBaseUrl }); break
      case 'web-search-deepseek': replace({ ...fields, baseURL: config.providers.searchBaseUrl }); break
      case 'webserver': replace({ host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 }); break
      case 'web-runtime': replace({ surfaceContext: false, openBrowser: false, printUrl: false }); break
      case 'sandbox-policy': replace({ mode: config.sandbox.mode, workspaceRoot: process.cwd() }); break
      case 'approval': replace({ policy: config.sandbox.approval }); break
      case 'session-telemetry-otel':
        replace({ ...fields, dshHome: home, mode: config.telemetry.mode, exporter: { url: config.telemetry.url, compression: 'gzip', timeoutMillis: 1000 } })
        entry.disabled = !config.telemetry.enabled
        break
      default: break
    }
  }
  entries.forEach(visit)
  return [{ insert: entries }]
}
