import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { composeEntries, initProfile, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { harnessComposition, harnessDefaults } from '@deepseek-ai/dsh-host-harness-product/composition'
import type { HarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'
import { createHarnessEmbed } from '@deepseek-ai/dsh-host-harness-product/embed/controller'
import { EmbedSession } from '@deepseek-ai/dsh-host-harness-product/embed/runtime'
import { PROFILE_ROOT_FILENAME, runProfile } from './profile-boot.ts'

const localOnly = new Set([
  'webserver', 'web-runtime', 'web-startup', 'authentication-token', 'api-remotes', 'client-hmr', 'modules',
  'schedule', 'tool-schedule', 'job-controller', 'terminal-controller', 'workspace-files',
  'cordis-host-runner', 'cordis-inspect-providers', 'tool-cordis', 'plugin-inventory', 'tool-plugin-manager', 'open-in-app', 'permission',
  'desktop-product-telemetry', 'product-analytics', 'session-telemetry-otel', 'session-log-deepseek', 'plugin-package-inventory-deepseek',
  'workspace-changes', 'harness-dev-context', 'tool-subagent-control', 'tool-subagent-fork', 'tool-subagent', 'tool-agent-team',
  'tool-jobs', 'workflow-ptc', 'tool-workflow', 'directory-picker',
])

/** 本机公开入口只启动本业务会话的隔离子树，使用部署的模型配置。 */
export function businessAssistant(options: {
  config: HarnessConfig
  home: string
  installAnchor: string
  environment: Readonly<NodeJS.ProcessEnv>
  primaryRuntime?: string
}): ReturnType<typeof createHarnessEmbed> {
  const { config, home } = options
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return createHarnessEmbed(config, home, async (grant) => {
    if (options.primaryRuntime) process.env.DSH_PRIMARY_RUNTIME = options.primaryRuntime
    const componentRoot = join(grant.root, 'profiles', 'business-assistant')
    initProfile(componentRoot, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    // 受管 profile 的加载器从本次会话的空根文件应用内置组合包。
    await writeFile(join(componentRoot, PROFILE_ROOT_FILENAME), '[]\n', { mode: 0o600 })
    const profile = loadProfileDirectory('dsh', componentRoot, options.installAnchor, { userLayer: false })
    const session = new EmbedSession(grant)
    const runtime = await runProfile({
      managed: true,
      profile: profile.name,
      resolvedProfile: { profile, installAnchor: options.installAnchor },
      patchFiles: [],
      args: [],
      product: {
        home: grant.root,
        configurationHome: grant.root,
        patches: [],
        defaults: patches => harnessDefaults(patches, config, options.environment),
        transform: (patches) => {
          const modelHome = join(config.storage.root, 'business-models')
          const rows = composeEntries([harnessComposition(patches, config, grant.root, modelHome)])
          const restrict = (entry: EntryOptions): void => {
            if (localOnly.has(entry.id) || entry.id.startsWith('ui-') || entry.name.startsWith('@deepseek-ai/dsh-client-ui-')
              || (!grant.desktop && /^(cua|computer-use)/u.test(entry.id))) entry.disabled = true
            if (entry.id === 'sandbox-policy') {
              entry.config = { mode: config.sandbox.mode === 'read-only' ? 'read-only' : 'workspace-write', workspaceRoot: grant.workspace }
            }
            if (entry.id === 'approval') {
              entry.config = { ...entry.config as object, policy: 'ask' }
            }
            if (entry.id === 'session-query-sqlite') {
              entry.config = { path: ':memory:', openAt: 'never' }
            }
            const pluginConfig: unknown = entry.config
            const children = typeof pluginConfig === 'object' && pluginConfig !== null && 'plugins' in pluginConfig
              ? pluginConfig.plugins : pluginConfig
            if (Array.isArray(children)) (children as EntryOptions[]).forEach(restrict)
          }
          rows.forEach(restrict)
          return [{ insert: rows }]
        },
        prepare: (child) => {
          child.provide('fileDeployment', true)
          child.provide('fileDeploymentHome', grant.root)
          child.provide('webStartup', { host: '127.0.0.1', port: 0, openBrowser: false, trustedHosts: [] })
          session.install(child)
        },
      },
    })
    try {
      grant.signal.throwIfAborted()
      await session.start(runtime.ctx)
      return {
        request: (operation, id, frame) => session.request(operation, id, frame),
        dispose: async () => { try { await session.dispose() } finally { await runtime.dispose() } },
      }
    } catch (failure) {
      await runtime.dispose()
      throw failure
    }
  })
}
