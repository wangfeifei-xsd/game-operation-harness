/** 源码启动显式选环境，正式安装只信任随包的部署描述与配置。 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readHarnessConfig, type HarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'

/** 主进程和 Host 共用的只读部署资源位置。 */
export interface DesktopProductConfiguration { config: HarnessConfig; directory: string; mode: 'local' | 'release' }

/**
 * 不根据 cwd、DSH_HOME 或 .env 选择产品身份服务。
 * @param packaged - 是否为已打包应用。
 * @param applicationDirectory - Electron 应用目录。
 * @param args - 开发时显式的 --environment 参数。
 * @returns 经验证的环境与配置位置。
 */
export function readDesktopProductConfiguration(packaged: boolean, applicationDirectory: string,
  args: readonly string[]): DesktopProductConfiguration {
  let directory: string
  let environment: string
  let mode: 'local' | 'release' = 'local'
  if (packaged) {
    directory = join(applicationDirectory, 'product', 'environments')
    const descriptor: unknown = JSON.parse(readFileSync(join(applicationDirectory, 'product', 'deployment.json'), 'utf8'))
    if (typeof descriptor !== 'object' || descriptor === null || !('schemaVersion' in descriptor) || descriptor.schemaVersion !== 1
      || !('environment' in descriptor) || typeof descriptor.environment !== 'string'
      || !('mode' in descriptor) || !['local','release'].includes(String(descriptor.mode))) throw new Error('桌面部署资源描述无效')
    environment = descriptor.environment
    mode = descriptor.mode as 'local' | 'release'
  } else {
    directory = resolve(applicationDirectory, '../../config/environments')
    const index = args.indexOf('--environment')
    environment = index === -1 ? 'test' : args[index + 1] ?? ''
  }
  const config = readHarnessConfig(environment, directory)
  if (mode === 'release' && (config.desktop.appId.startsWith('local.') || !config.desktop.updates.enabled ||
    config.desktop.downloadIndexUrl === null)) {
    throw new Error('正式桌面发布缺少应用身份、下载索引或普通更新源')
  }
  if (packaged && Object.keys(config.providers.credentials).length !== 0) throw new Error('公开桌面安装包不能包含供应商凭据')
  return { config, directory, mode }
}
