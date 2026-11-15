/** 发布测试提供独立的受控文件配置；不会读取本机发布输入或实际网络。 */
import { vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-desktop-publisher/product-deployment.mjs', async () => {
  const { readHarnessConfig } = await import('@deepseek-ai/dsh-host-harness-product/config')
  const { fileURLToPath } = await import('node:url')
  function desktopProductDeployment(env: NodeJS.ProcessEnv = process.env) {
    const environment = env.DSH_DESKTOP_PRODUCT_ENVIRONMENT ?? (env.DSH_DESKTOP_AUTO_UPDATE_ENV === 'production' ? 'master' : 'test')
    const config = readHarnessConfig('test', fileURLToPath(new URL('../../../config/environments/', import.meta.url)))
    if (!['dev', 'test', 'fat', 'master'].includes(environment)) throw new Error('桌面产品环境无效')
    return { ...config, environment, desktop: {
      appId: `com.example.agentassistant.${environment}`, protocol: `agent-assistant${environment === 'master' ? '' : `-${environment}`}`,
      channel: 'stable', downloadIndexUrl: `https://updates.example.com/agent-assistant/${environment}/stable/downloads.json`,
      updates: { enabled: true, url: `https://updates.example.com/agent-assistant/${environment}/stable/` },
      mandatoryUpdate: { enabled: false, url: null },
    } }
  }
  return { desktopProductDeployment, desktopRetainedDeployment(source: import('@deepseek-ai/dsh-desktop-publisher/desktop-release-store.ts').DesktopRetainedSource) {
    if (source.product !== 'agent-assistant' || source.productEnvironment === undefined || source.appId === undefined) throw new Error('保留构建不含本产品身份，请重新构建')
    const config = desktopProductDeployment({ DSH_DESKTOP_PRODUCT_ENVIRONMENT: source.productEnvironment })
    if (config.desktop.appId !== source.appId || (source.productEnvironment === 'master' ? 'production' : 'test') !== source.preset) throw new Error('保留构建与产品环境配置不匹配')
    return config
  } }
})
