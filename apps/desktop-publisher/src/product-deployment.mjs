/** 构建子进程只传递显式环境选择；产品配置始终来自受控文件。 */
import { fileURLToPath } from 'node:url'
import { readHarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'

/**
 * @param {NodeJS.ProcessEnv} env 构建器传递的环境选择，不包含产品字段覆盖。
 * @param {boolean} release 是否要求正式分发输入齐备。
 * @returns {import('@deepseek-ai/dsh-host-harness-product/config').HarnessConfig} 经过校验的部署配置。
 */
export function desktopProductDeployment(env = process.env, release = false) {
  const environment = env.DSH_DESKTOP_PRODUCT_ENVIRONMENT ?? 'test'
  const directory = fileURLToPath(new URL('../../../config/environments/', import.meta.url))
  const config = readHarnessConfig(environment, directory)
  if (Object.keys(config.providers.credentials).length !== 0) throw new Error('公开安装包不能包含供应商凭据')
  if (release && (config.desktop.appId.startsWith('local.') || config.desktop.downloadIndexUrl === null || !config.desktop.updates.enabled)) {
    throw new Error('正式发布缺少应用身份、下载索引或普通更新源，请配置所选环境文件')
  }
  return config
}

/**
 * @param {import('./desktop-release-store.ts').DesktopRetainedSource} source 保留构建中的产品身份。
 * @returns {import('@deepseek-ai/dsh-host-harness-product/config').HarnessConfig} 与构建一致的文件配置；旧上游产物不得发布。
 */
export function desktopRetainedDeployment(source) {
  if (source.product !== 'agent-assistant' || source.productEnvironment === undefined || source.appId === undefined) throw new Error('保留构建不含本产品身份，请重新构建')
  const config = desktopProductDeployment({ DSH_DESKTOP_PRODUCT_ENVIRONMENT: source.productEnvironment }, true)
  if (config.desktop.appId !== source.appId || (config.environment === 'master' ? 'production' : 'test') !== source.preset) throw new Error('保留构建与产品环境配置不匹配')
  return config
}
