/** 产品认证的静态 Node 库；入口显式选择子模块。 */
export { HarnessAuthClient, HarnessAuthError } from './auth-client.ts'
export type { HarnessUser, HarnessSession, HarnessLogin } from './auth-client.ts'
export { readHarnessConfig, parseHarnessConfig, harnessUserHome } from './config.ts'
export type { HarnessConfig, HarnessEnvironment } from './config.ts'
