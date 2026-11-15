/** 在账号目录锁内迁移旧渠道目录，不合并来源不明的数据。 */
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import lockfile from 'proper-lockfile'
import { HarnessAuthError } from './harness-auth-client.ts'
import { harnessUserHome, type HarnessConfig } from './harness-config.ts'

function inspect(path: string): Stats | undefined {
  try { return lstatSync(path) }
  catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined
    throw error
  }
}

/**
 * 首次登录搬移唯一旧目录，重复目录、符号链接或占用均拒绝；新账号创建空目录。
 * 调用方须先取得目标路径锁；同步迁移期间不让退出与新登录交错修改目录。
 * @param config - 已验证的环境配置。
 * @param user - 中央认证返回的用户标识。
 */
export function migrateHarnessUserHome(config: HarnessConfig, user: string): void {
  try {
    const home = harnessUserHome(config, user)
    const parent = dirname(home)
    const suffix = relative(realpathSync(config.storage.root), realpathSync(parent))
    if (lstatSync(parent).isSymbolicLink() || suffix.startsWith('..') || isAbsolute(suffix)) {
      throw new HarnessAuthError(503, 'HARNESS_HOME_INVALID', '账号数据目录无效')
    }
    const destination = inspect(home)
    if (destination !== undefined && (!destination.isDirectory() || destination.isSymbolicLink())) {
      throw new HarnessAuthError(503, 'HARNESS_HOME_INVALID', '账号数据目录无效')
    }
    const sources: string[] = []
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (entry.name === user || !entry.isDirectory() && !entry.isSymbolicLink()) continue
      const candidate = join(parent, entry.name, user)
      const previous = inspect(candidate)
      if (previous === undefined) continue
      if (entry.isSymbolicLink() || previous.isSymbolicLink() || !previous.isDirectory()) {
        throw new HarnessAuthError(503, 'HARNESS_HOME_INVALID', '旧账号目录存在异常路径，请核对后重试')
      }
      sources.push(candidate)
    }
    if (sources.length > 1 || destination !== undefined && sources.length !== 0) {
      throw new HarnessAuthError(409, 'HARNESS_HOME_CONFLICT', '发现多份账号数据，请停止实例并核对目录后重试')
    }
    const source = sources[0]
    if (source !== undefined) {
      let release: () => void
      try { release = lockfile.lockSync(source, { retries: 0, stale: 15_000 }) }
      catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'ELOCKED') {
          throw new HarnessAuthError(409, 'HARNESS_HOME_IN_USE', '旧账号目录正在使用，请停止旧实例后重试', { cause })
        }
        throw cause
      }
      try { renameSync(source, home) }
      finally { release() }
    } else if (destination === undefined) mkdirSync(home, { mode: 0o700 })
  } catch (cause) {
    if (cause instanceof HarnessAuthError) throw cause
    throw new HarnessAuthError(503, 'HARNESS_HOME_INVALID', '账号目录准备失败，请核对本地数据和目录权限后重试', { cause })
  }
}
