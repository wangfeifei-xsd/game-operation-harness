/** Web 载体的同源公开认证请求；不接收任意地址或中央凭据。 */
import { copy, LocalAuthError, type AuthOperation, type AuthTransport } from './shared.ts'

/**
 * 每个页面独立创建传输，页面负责退出后的导航。
 * @returns 仅访问固定本机认证路径的适配器。
 */
export function createWebAuthTransport(): AuthTransport {
  return { async request<T>(operation: AuthOperation, data?: object, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`/harness/api/${operation}`, { method: data === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(signal === undefined ? {} : { signal }) })
    const value: unknown = await response.json()
    if (!response.ok) {
      const error = typeof value === 'object' && value !== null && 'error' in value ? value.error : undefined
      throw new LocalAuthError(response.status, typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : copy.unavailable)
    }
    return value as T
  } }
}
