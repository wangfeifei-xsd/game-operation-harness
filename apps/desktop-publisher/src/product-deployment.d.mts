/** 从仓库受控环境文件读取构建配置；运行时改读随包资源。 */
import type { HarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'
/** @param env 构建子进程的显式环境选择。 @param release 是否要求正式输入。 @returns 完整文件配置。 */
export function desktopProductDeployment(env?: NodeJS.ProcessEnv, release?: boolean): HarnessConfig
/** @param source 保留构建的产品身份。 @returns 与构建一致的受控配置；旧上游产物被拒绝。 */
export function desktopRetainedDeployment(source: import('./desktop-release-store.ts').DesktopRetainedSource): HarnessConfig
