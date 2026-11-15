/** Web/PWA 与桌面共用的产品模型装配，不改动各自认证和插件管理。 */
import { join } from 'node:path'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'

const removed = new Set([
  'deepseek-account', 'llm-deepseek-account', 'llm-deepseek', 'llm-deepseek-api-key', 'llm-pi-ai',
  'ui-settings-account', 'ui-account-notifications', 'deepseek-llm-api-extensions',
])
const removedPackages = new Set([
  '@deepseek-ai/dsh-deepseek-account', '@deepseek-ai/dsh-llm-deepseek-account', '@deepseek-ai/dsh-llm-deepseek',
  '@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh-llm-deepseek-api-key', '@deepseek-ai/dsh-client-ui-settings-account', '@deepseek-ai/dsh-client-ui-account-notifications',
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
])

/**
 * 最终模型树只保留当前 Host 的产品配置来源；现有 profile 同样受约束。
 * @param patches - 当前入口已经解析的完整补丁。
 * @param home - 已解析并验证的数据根。
 * @returns 产品模型最终装配。
 */
export function modelComposition(patches: PatchOptions[], home: string): PatchOptions[] {
  const filter = (entries: EntryOptions[]): EntryOptions[] => entries.filter(entry => !removed.has(entry.id)
    && !removed.has(entry.name) && !removedPackages.has(entry.name)
    && entry.id !== 'harness-model-config' && entry.id !== 'model-config-controller'
    && entry.name !== '@deepseek-ai/dsh-harness-model-config' && entry.name !== '@deepseek-ai/dsh-api-model-config-controller').map((entry) => {
    if (Array.isArray(entry.config)) entry.config = filter(entry.config as EntryOptions[])
    const fields = typeof entry.config === 'object' && entry.config !== null && !Array.isArray(entry.config) ? entry.config as Record<string, unknown> : {}
    if (Array.isArray(fields.plugins)) fields.plugins = filter(fields.plugins as EntryOptions[])
    if (entry.id === 'storage-json') entry.config = { ...fields, root: join(home, 'storages') }
    if (entry.id === 'credentials') entry.config = { ...fields, dshHome: home, path: join(home, '.credentials.yaml') }
    if (entry.id === 'agent-default-model') entry.config = { ...fields, sourceRequired: true }
    if (entry.id === 'ui-settings-models') entry.config = { directModels: true, credentialOnboarding: false }
    if (entry.id === 'web-deepseek-api') entry.config = { ...fields, searchBilling: 'api-key', fetchBilling: 'api-key', searchApiKeyEnv: 'HARNESS_SEARCH_API_KEY', fetchApiKeyEnv: 'HARNESS_SEARCH_API_KEY' }
    return entry
  })
  const entries = filter(composeEntries([patches]))
  entries.push({ id: 'harness-model-config', name: '@deepseek-ai/dsh-harness-model-config', config: { root: join(home, 'storages') } },
    { id: 'model-config-controller', name: '@deepseek-ai/dsh-api-model-config-controller' })
  return [{ insert: entries }]
}
