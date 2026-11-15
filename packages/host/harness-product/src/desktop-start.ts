/** 桌面主进程只经私有 IPC 交付的版本化启动身份。 */
import { HarnessAuthError, parseHarnessSession, type HarnessUser } from './auth-client.ts'
import type { HarnessEnvironment } from './config.ts'

/** 该消息不能写入日志、argv、环境或 Renderer。 */
export interface DesktopProductStart {
  version: 1
  generation: number
  environment: HarnessEnvironment
  configDirectory: string
  token: string
  sessionId: string
  user: HarnessUser
}

/**
 * 验证进程间启动身份，不从页面推导用户或数据根。
 * @param value - 私有 IPC 的原始对象。
 * @returns 完整且已校验的启动消息。
 */
export function parseDesktopProductStart(value: unknown): DesktopProductStart {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || !('version' in value) || value.version !== 1
    || !('generation' in value) || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !('environment' in value) || !['dev','test','fat','master'].includes(String(value.environment))
    || !('configDirectory' in value) || typeof value.configDirectory !== 'string' || !value.configDirectory
    || !('token' in value) || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.token)
    || !('sessionId' in value) || !('user' in value)) throw new HarnessAuthError(403, 'HARNESS_PRIVATE_ONLY', '桌面私有启动身份无效')
  const session = parseHarnessSession({ session_id: value.sessionId, user: value.user, expires_in: 1,
    expires_at: '2000-01-01T00:00:00Z', absolute_expires_at: '2000-01-01T00:00:00Z' })
  return { version: 1, generation: value.generation, environment: value.environment as HarnessEnvironment,
    configDirectory: value.configDirectory, token: value.token, sessionId: session.session_id, user: session.user }
}
