/** 下载索引只接受本产品、所选部署及受控 HTTPS 源的真实产物。 */
import { HarnessAuthError } from './auth-client.ts'
import { HARNESS_BRAND, type HarnessConfig } from './config.ts'

/** 本轮提供的安装目标。 */
export type DesktopDownloadTarget = 'macos-arm64' | 'macos-x64' | 'windows-x64'
/** 发布器已经核验的安装文件，不允许推测其他架构的地址。 */
export interface DesktopDownloadFile { target: DesktopDownloadTarget; url: string; filename: string; bytes: number; sha256: string }
/** 同一环境和频道的一次公开发布。 */
export interface DesktopDownloadIndex {
  schemaVersion: 1
  product: 'agent-assistant'
  appId: string
  environment: HarnessConfig['environment']
  channel: 'stable'
  version: string
  publishedAt: string
  files: DesktopDownloadFile[]
}

/** 下载读取器只需要公开部署字段，不暴露服务凭据或其他配置。 */
export interface DesktopDownloadDeployment {
  environment: HarnessConfig['environment']
  desktop: Pick<HarnessConfig['desktop'], 'downloadIndexUrl' | 'appId' | 'channel'>
}

function invalid(): never { throw new HarnessAuthError(503, 'HARNESS_DOWNLOAD_INVALID', '下载信息暂不可用，请稍后重试') }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/**
 * 发布器与公开入口使用同一校验；文件和索引必须同源。
 * @param value - 不可信索引 JSON。
 * @param config - 所选部署及索引地址。
 * @returns 已筛选的公开下载索引。
 */
export function parseDesktopDownloadIndex(value: unknown, config: DesktopDownloadDeployment): DesktopDownloadIndex {
  const index = record(value)
  const source = config.desktop.downloadIndexUrl
  if (source === null || index.schemaVersion !== 1 || index.product !== HARNESS_BRAND.slug
    || index.appId !== config.desktop.appId || index.environment !== config.environment || index.channel !== config.desktop.channel
    || typeof index.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(index.version)
    || typeof index.publishedAt !== 'string' || !Number.isFinite(Date.parse(index.publishedAt))
    || !Array.isArray(index.files) || index.files.length > 3) invalid()
  const version = index.version
  const targets = new Set<string>()
  const files = index.files.map((raw): DesktopDownloadFile => {
    const file = record(raw)
    if (typeof file.target !== 'string' || !['macos-arm64','macos-x64','windows-x64'].includes(file.target) || targets.has(file.target)
      || typeof file.url !== 'string' || !URL.canParse(file.url) || typeof file.filename !== 'string'
      || !/^agent-assistant-[A-Za-z0-9._-]+\.(dmg|exe)$/u.test(file.filename)
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes <= 0
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)) invalid()
    const url = new URL(file.url)
    const suffix = file.target === 'windows-x64' ? 'win-x64.exe' : `mac-${file.target.slice(6)}.dmg`
    if (url.protocol !== 'https:' || url.origin !== new URL(source).origin || url.username || url.password || url.hash || url.search
      || decodeURIComponent(url.pathname.split('/').at(-1) ?? '') !== file.filename
      || file.filename !== `agent-assistant-${version}-${suffix}`) invalid()
    targets.add(file.target)
    return { target: file.target as DesktopDownloadTarget, url: url.href, filename: file.filename, bytes: file.bytes, sha256: file.sha256 }
  })
  return { schemaVersion: 1, product: HARNESS_BRAND.slug, appId: config.desktop.appId, environment: config.environment,
    channel: config.desktop.channel, version: index.version, publishedAt: index.publishedAt, files }
}

/**
 * 从显式源读取索引；关闭、未发布、网络错误均不拼造下载链接。
 * @param config - 所选部署。
 * @returns 经过完整校验的索引；空表示尚未配置发布。
 */
export async function readDesktopDownloadIndex(config: HarnessConfig): Promise<DesktopDownloadIndex | null> {
  if (config.desktop.downloadIndexUrl === null) return null
  try {
    const response = await fetch(config.desktop.downloadIndexUrl, { redirect: 'error', signal: AbortSignal.timeout(5000), cache: 'no-store' })
    if (!response.ok || response.body === null) invalid()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        if (size > 1_048_576) invalid()
        chunks.push(result.value)
      }
    } finally { await reader.cancel() }
    return parseDesktopDownloadIndex(JSON.parse(Buffer.concat(chunks).toString('utf8')), config)
  } catch (_invalidOrUnavailable) { return invalid() }
}
