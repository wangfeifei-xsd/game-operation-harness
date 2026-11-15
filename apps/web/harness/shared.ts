/** 浏览器只调用本机同源接口，不持有中央服务凭据。 */
const zh = {
  login: '登录', register: '注册', account: '登录名', name: '显示名称', password: '密码',
  required: '请填写此项', passwordLength: '密码长度为 12–256 个字符', verify: '点击完成滑动验证',
  verified: '验证已通过', captcha: '滑动验证', drag: '拖动滑块，使拼图与缺口重合',
  refresh: '换一张', confirm: '确认位置', position: '拼图位置', image: '验证图片', piece: '待对齐的拼图',
  unavailable: '服务暂不可用，请稍后重试', registered: '注册成功，请登录', logout: '退出登录',
  logoutConfirm: '退出并停止当前任务？', cancel: '取消', cancelLogin: '取消登录',
  loggingOut: '正在退出', remoteUnknown: '本机已退出，远端退出未确认',
  expired: '会话已结束，请重新登录', captchaRequired: '请先完成滑动验证',
}
const en: Record<keyof typeof zh, string> = {
  login: 'Sign in', register: 'Register', account: 'Username', name: 'Display name', password: 'Password',
  required: 'This field is required', passwordLength: 'Use 12–256 characters', verify: 'Complete the slider challenge',
  verified: 'Verified', captcha: 'Verification', drag: 'Drag the piece into the gap',
  refresh: 'New image', confirm: 'Confirm position', position: 'Puzzle position', image: 'Verification image', piece: 'Puzzle piece',
  unavailable: 'Service unavailable. Try again later.', registered: 'Registered. Sign in to continue.', logout: 'Sign out',
  logoutConfirm: 'Sign out and stop current tasks?', cancel: 'Cancel', cancelLogin: 'Cancel sign-in',
  loggingOut: 'Signing out', remoteUnknown: 'Signed out locally. Remote sign-out was not confirmed.',
  expired: 'Session ended. Sign in again.', captchaRequired: 'Complete verification first',
}
/** 浏览器首选语言决定认证界面字典。 */
export const copy = navigator.language.toLowerCase().startsWith('zh') ? zh : en

/** 同源接口失败保留服务端业务反馈，网络失败使用本地字典。 */
export class LocalAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
/**
 * 请求同源认证接口；返回值只用于该页面的公开 DTO。
 * @param path - 本机认证接口路径。
 * @param data - POST 正文，省略时使用 GET。
 * @param signal - 页面拥有的取消信号。
 * @returns 成功的 JSON 正文。
 */
export async function api<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/harness/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' }, credentials: 'same-origin', cache: 'no-store',
    ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(signal === undefined ? {} : { signal }) })
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'object' && value.error !== null
      && 'message' in value.error && typeof value.error.message === 'string' ? value.error.message : copy.unavailable
    throw new LocalAuthError(response.status, message)
  }
  return value as T
}
/** 页面只使用经过服务器筛选的当前用户与登录状态。 */
export interface LocalSession { authenticated: boolean; user?: { display_name: string }; error?: { message: string } }
/**
 * 选择可读错误反馈。
 * @param error - 操作失败。
 * @returns 字典反馈或服务端业务说明。
 */
export function errorText(error: unknown): string { return error instanceof LocalAuthError ? error.message : copy.unavailable }
