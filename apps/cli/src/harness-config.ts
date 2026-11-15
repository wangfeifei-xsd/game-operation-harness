/** CLI 为每种安装布局显式选择部署资源目录。 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readHarnessConfig as readSharedConfig } from '@deepseek-ai/dsh-host-harness-product/config'
export { parseHarnessConfig, harnessUserHome } from '@deepseek-ai/dsh-host-harness-product/config'
export type { HarnessConfig, HarnessEnvironment } from '@deepseek-ai/dsh-host-harness-product/config'
/**
 * 读取 CLI 随附的完整环境文件。
 * @param environment - 显式部署环境。
 * @returns 校验后的配置。
 */
export function readHarnessConfig(environment: string | undefined) {
  const source = new URL('../../../config/environments/', import.meta.url)
  const directory = existsSync(source) ? source : new URL('./resources/environments/', import.meta.url)
  return readSharedConfig(environment, fileURLToPath(directory))
}
