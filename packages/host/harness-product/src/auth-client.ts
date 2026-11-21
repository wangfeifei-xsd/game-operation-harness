/** Creativity 的服务器认证客户端；中央 Token 只存在 Node 内存。 */
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { HarnessConfig } from './config.ts'

/** 终端账号的公开资料。 */
export interface HarnessUser {
  user_id: string
  login_name: string
  display_name: string
  status: 'ACTIVE'
}
/** 中央会话的可验证响应。 */
export interface HarnessSession {
  session_id: string
  expires_in: number
  expires_at: string
  absolute_expires_at: string
  user: HarnessUser
}
/** 登录时返回给 Node 的私有凭据。 */
export interface HarnessLogin extends HarnessSession { access_token: string; token_type: 'Bearer' }
/** 可反馈给浏览器的认证失败。 */
export class HarnessAuthError extends HarnessError {
  constructor(readonly status: number, code: string, message: string, options?: ErrorOptions) { super(message, code,
    options); this.name = 'HarnessAuthError' }
}

/**
 * 校验外部认证响应；不接受缺字段、非法身份或伪造到期值。
 * @param value - 中央 JSON 响应。
 * @returns 已验证的会话。
 */
export function parseHarnessSession(value: unknown): HarnessSession {
  if (typeof value !== 'object' || value === null || !('session_id' in value) || typeof value.session_id !== 'string'
    || !('expires_in' in value) || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in)
    || !('expires_at' in value) || typeof value.expires_at !== 'string' || !Number.isFinite(Date.parse(value.expires_at))
    || !('absolute_expires_at' in value) || typeof value.absolute_expires_at !== 'string' ||
      !Number.isFinite(Date.parse(value.absolute_expires_at))
    || !('user' in value) || typeof value.user !== 'object' || value.user === null) throw new HarnessAuthError(503,
    'HARNESS_AUTH_UNAVAILABLE','认证服务响应无效')
  const user = value.user
  if (!('user_id' in user) || typeof user.user_id !== 'string'
    || !('login_name' in user) || typeof user.login_name !== 'string' || !('display_name' in user) || typeof user.display_name !== 'string'
    || !('status' in user) || user.status !== 'ACTIVE'
    || ![user.user_id,value.session_id].every(id => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(id))) throw new HarnessAuthError(503,'HARNESS_AUTH_UNAVAILABLE','认证服务身份无效')
  return { session_id:value.session_id,expires_in:value.expires_in,
    expires_at:value.expires_at,absolute_expires_at:value.absolute_expires_at,
    user:{ user_id:user.user_id,login_name:user.login_name,display_name:user.display_name,status:'ACTIVE' } }
}

/** 认证客户端每个请求独立校验，不合并在途请求或缓存通过结果。 */
export class HarnessAuthClient {
  constructor(private readonly config: HarnessConfig) {}

  /**
   * 发起一次认证请求，依赖失联统一返回服务不可用。
   * @param path - Harness API 内部路径。
   * @param method - HTTP 方法。
   * @param body - 经调用方选择的请求正文。
   * @param token - Node 内存中的中央凭据。
   * @returns 中央响应 JSON。
   */
  async request(path: string, method = 'GET', body?: unknown, token?: string): Promise<unknown> {
    try {
      const response = await fetch(`${this.config.creativity.baseUrl.replace(/\/$/u,'')}/api/v1/harness${path}`, {
        method, headers:{ 'content-type':'application/json',...(token === undefined ? {} : { authorization:`Bearer ${token}` }) },
        ...(body === undefined ? {} : { body:JSON.stringify(body) }),
        signal:AbortSignal.timeout(this.config.creativity.requestTimeoutMs), redirect:'error',
      })
      const value: unknown = response.status === 204 ? undefined : await response.json()
      if (!response.ok) {
        if (typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'object' && value.error !== null
          && 'message' in value.error && typeof value.error.message === 'string' && 'code' in value.error &&
            typeof value.error.code === 'string') {
          throw new HarnessAuthError(response.status,value.error.code,value.error.message)
        }
        throw new HarnessAuthError(response.status,'HARNESS_AUTH_UNAVAILABLE','认证服务暂不可用')
      }
      return value
    } catch (error) {
      if (error instanceof HarnessAuthError) throw error
      throw new HarnessAuthError(503,'HARNESS_AUTH_UNAVAILABLE','认证服务暂不可用')
    }
  }

  /** 验证部署标识，防止账号被发送到错误部署。 */
  async bootstrap(): Promise<void> {
    const value = await this.request('/bootstrap')
    if (typeof value !== 'object' || value === null || !('deployment_id' in value) ||
      value.deployment_id !== this.config.creativity.deploymentId) throw new HarnessAuthError(503,'HARNESS_DEPLOYMENT_MISMATCH','认证部署标识不匹配')
  }

  /**
   * 登录窗口只取得经过部署核验的公开注册规则。
   * @returns 注册开关与密码长度，不包含部署私有配置。
   */
  async publicBootstrap(): Promise<{ registration_enabled: boolean; password_min_length: number; password_max_length: number }> {
    const value = await this.request('/bootstrap')
    if (typeof value !== 'object' || value === null || !('deployment_id' in value) ||
      value.deployment_id !== this.config.creativity.deploymentId) throw new HarnessAuthError(503,
      'HARNESS_DEPLOYMENT_MISMATCH', '认证部署标识不匹配')
    if (!('registration_enabled' in value) || typeof value.registration_enabled !== 'boolean'
      || !('password_min_length' in value) || typeof value.password_min_length !== 'number' ||
        !Number.isSafeInteger(value.password_min_length) || value.password_min_length < 1
      || !('password_max_length' in value) || typeof value.password_max_length !== 'number' ||
        !Number.isSafeInteger(value.password_max_length) || value.password_max_length < value.password_min_length ||
          value.password_max_length > 4096) throw new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证注册规则无效')
    return { registration_enabled: value.registration_enabled, password_min_length: value.password_min_length,
      password_max_length: value.password_max_length }
  }

  /**
   * 每次调用重新确认中央会话。
   * @param token - 中央凭据。
   * @param renew - 真实用户操作是否更新空闲期限。
   * @returns 已验证会话。
   */
  async session(token: string, renew = false): Promise<HarnessSession> {
    return parseHarnessSession(await this.request(renew ? '/auth/renew' : '/auth/session',renew ? 'POST' : 'GET',undefined,token))
  }

  /**
   * 登录并校验中央返回的私有 Token。
   * @param body - 用户登录输入。
   * @returns 中央会话与私有 Token。
   */
  async login(body: unknown): Promise<HarnessLogin> {
    await this.bootstrap()
    const value = await this.request('/auth/login', 'POST', body)
    const session = parseHarnessSession(value)
    if (typeof value !== 'object' || value === null || !('access_token' in value) || typeof value.access_token !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(value.access_token) || !('token_type' in value) ||
        value.token_type !== 'Bearer') throw new HarnessAuthError(503,'HARNESS_AUTH_UNAVAILABLE','认证服务凭据无效')
    return { ...session,access_token:value.access_token,token_type:'Bearer' }
  }
}
