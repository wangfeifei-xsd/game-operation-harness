/** 浏览器只调用本机同源接口，不持有中央服务凭据。 */
const zh = {
  login: '登录', register: '注册', account: '登录名', name: '显示名称', password: '密码',
  required: '请填写此项', passwordLength: '密码长度为 12–256 个字符', verify: '点击完成滑动验证',
  verified: '验证已通过', captcha: '滑动验证', drag: '拖动滑块，使拼图与缺口重合', slide: '拖动滑块完成验证',
  refresh: '换一张', confirm: '确认位置', position: '拼图位置', image: '验证图片', piece: '待对齐的拼图',
  unavailable: '服务暂不可用，请稍后重试', registered: '注册成功，请登录', logout: '退出登录', signedIn: '已登录',
  logoutConfirm: '退出并停止当前任务？', cancel: '取消', cancelLogin: '取消登录',
  product: 'Agent 助手', download: '下载桌面版', downloadTitle: '下载 Agent 助手', unpublished: '桌面版尚未发布',
  appearance: '界面风格', light: '浅色', dark: '深色',
  downloadFailed: '下载信息暂不可用，请稍后重试', downloadFile: '下载安装包', target: '选择系统与架构', retry: '重试',
  macArm: 'macOS · Apple Silicon', macIntel: 'macOS · Intel', winX64: 'Windows · x64', fileSize: '文件大小', checksum: 'SHA-256',
  starting: '正在启动', stopping: '正在停止', authenticating: '正在登录', revalidating: '正在验证登录状态', retryStop: '重试停止',
  loggingOut: '正在退出', remoteUnknown: '本机已退出，远端退出未确认',
  expired: '会话已结束，请重新登录', captchaRequired: '请先完成滑动验证',
  businessAssistant: '连接业务助手', businessShort: '业务', businessCode: '配对码', businessLookup: '核对业务账号',
  businessWorkspace: '本机工作区', businessWorkspacePath: '输入已有目录的绝对路径', businessBrowse: '选择目录',
  businessDesktop: '允许助手操作本机桌面', businessAgents: '允许助手调用已授权的 Creativity 智能体',
  businessLocalFiles: '在选定工作区使用文件和终端', businessGrant: '确认授予', businessDisconnect: '断开连接',
  businessWaitConfirm: '请在业务助手网页确认本机连接', businessConnected: '业务助手已连接', businessConnecting: '正在连接业务助手',
  businessPc: 'PC 客户端', businessWeb: '业务后台', businessLocal: '独立助手',
  businessChat: '打开业务会话',
}
const en: Record<keyof typeof zh, string> = {
  login: 'Sign in', register: 'Register', account: 'Username', name: 'Display name', password: 'Password',
  required: 'This field is required', passwordLength: 'Use 12–256 characters', verify: 'Complete the slider challenge',
  verified: 'Verified', captcha: 'Verification', drag: 'Drag the piece into the gap', slide: 'Slide to verify',
  refresh: 'New image', confirm: 'Confirm position', position: 'Puzzle position', image: 'Verification image', piece: 'Puzzle piece',
  unavailable: 'Service unavailable. Try again later.', registered: 'Registered. Sign in to continue.', logout: 'Sign out', signedIn: 'Signed in',
  logoutConfirm: 'Sign out and stop current tasks?', cancel: 'Cancel', cancelLogin: 'Cancel sign-in',
  product: 'Agent 助手', download: 'Download desktop app', downloadTitle: 'Download Agent 助手', unpublished: 'Desktop app not published yet',
  appearance: 'Appearance', light: 'Light', dark: 'Dark',
  downloadFailed: 'Download information unavailable. Try again later.', downloadFile: 'Download installer',
  target: 'System and architecture', retry: 'Retry',
  macArm: 'macOS · Apple Silicon', macIntel: 'macOS · Intel', winX64: 'Windows · x64', fileSize: 'File size', checksum: 'SHA-256',
  starting: 'Starting', stopping: 'Stopping', authenticating: 'Signing in', revalidating: 'Verifying session', retryStop: 'Retry stopping',
  loggingOut: 'Signing out', remoteUnknown: 'Signed out locally. Remote sign-out was not confirmed.',
  expired: 'Session ended. Sign in again.', captchaRequired: 'Complete verification first',
  businessAssistant: 'Connect Business Assistant', businessShort: 'Business', businessCode: 'Pairing code', businessLookup: 'Check business account',
  businessWorkspace: 'Local workspace', businessWorkspacePath: 'Absolute path to an existing folder', businessBrowse: 'Choose folder',
  businessDesktop: 'Allow desktop actions', businessAgents: 'Allow access to authorized Creativity agents',
  businessLocalFiles: 'Use files and the terminal in the selected workspace', businessGrant: 'Grant access', businessDisconnect: 'Disconnect',
  businessWaitConfirm: 'Confirm the device on the business page', businessConnected: 'Business Assistant connected', businessConnecting: 'Connecting to Business Assistant',
  businessPc: 'PC client', businessWeb: 'Business website', businessLocal: 'Standalone assistant',
  businessChat: 'Open business chat',
}
/** 选择当前语言的账号文案。 */
export const copy = typeof navigator === 'undefined' || navigator.language.toLowerCase().startsWith('zh') ? zh : en
/** 同源接口失败保留服务端业务反馈，网络失败使用本地字典。 */
export class LocalAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
/** 页面只使用经过服务器筛选的当前用户与登录状态。 */
export interface LocalSession {
  authenticated: boolean
  state?: string
  generation?: number
  user?: { display_name: string }
  error?: { message: string }
}
/**
 * 选择可读错误反馈。
 * @param error - 操作失败。
 * @returns 字典反馈或服务端业务说明。
 */
export function errorText(error: unknown): string { return error instanceof LocalAuthError ? error.message : copy.unavailable }

/** 已完成部署验证的公开注册规则。 */
export interface AuthBootstrap { registration_enabled: boolean; password_min_length: number; password_max_length: number }
/** 仅支持固定认证操作，不接受外部 URL 或中央 Token。 */
export type AuthOperation = 'bootstrap' | 'downloads' | 'session' | 'login' | 'register' | 'logout' | 'renew' | `pairing/${'status' | 'lookup' | 'pick' | 'claim' | 'disconnect'}` | `captcha/${'login' | 'register'}/${'challenges' | 'verify'}`
/** 两种载体提供同样的公开操作，导航仍由各自入口拥有。 */
export interface AuthTransport {
  request<T>(operation: AuthOperation, data?: object, signal?: AbortSignal): Promise<T>
}
