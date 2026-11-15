/** Web 与桌面共用的公开账号表单，不包含 Node 或中央凭据。 */
export { AuthPage } from './AuthPage.tsx'
export { copy, errorText, LocalAuthError } from './shared.ts'
export type { AuthTransport, AuthOperation, AuthBootstrap, LocalSession } from './shared.ts'
export { DownloadButton } from './DownloadButton.tsx'
export { AccountControls } from './AccountControls.tsx'
export { createWebAuthTransport } from './web-transport.ts'
