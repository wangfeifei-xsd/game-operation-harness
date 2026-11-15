/** Shared upload contracts for Desktop packaging and publication. */
import type { DesktopAutoUpdateTarget } from './desktop-auto-update-environment.mjs'
import type { DesktopDownloadDeployment, DesktopDownloadFile } from '@deepseek-ai/dsh-host-harness-product/downloads'

/** 由已校验安装文件派生的公开下载记录；上传端在核对远端字节后才能发布。 */
export interface DesktopDownloadPublication {
  readonly deployment: DesktopDownloadDeployment
  readonly key: string
  readonly installerKey: string
  readonly file: DesktopDownloadFile
}

/** One local file and its final object metadata. */
export interface DesktopUploadArtifact {
  readonly path: string
  readonly filename: string
  readonly key: string
  readonly contentType: string
  /** Browser save name for fixed website downloads, preserving the validated installer basename. */
  readonly contentDisposition?: string
  readonly channelMetadata: boolean
  /** Published YAML with normalized artifact URLs; binary bytes remain file-backed. */
  readonly contents?: string
}

/** A validated installer or update upload, with any channel metadata ordered last. */
export interface DesktopUploadPlan {
  readonly environment: 'test' | 'production'
  readonly target: DesktopAutoUpdateTarget
  readonly version: string
  /** Update feed directory URL, or the single installer URL for a fixed download. */
  readonly publicUrl: string
  readonly bucket: string
  readonly secretIdEnvName: string
  readonly secretKeyEnvName: string
  readonly artifacts: readonly DesktopUploadArtifact[]
  /** 普通发布完成后更新索引；固定别名上传不改变索引。 */
  readonly downloadIndex?: DesktopDownloadPublication
  /** Commit the artifacts were packaged from, absent for a package built before builds recorded it. */
  readonly commit?: string
  /** Whether that checkout carried uncommitted changes. */
  readonly dirty?: boolean
}

/** A publication operation targeting exactly one metadata object or installer. */
export type DesktopSingleUploadPlan = Omit<DesktopUploadPlan, 'artifacts'> & {
  readonly artifacts: readonly [DesktopUploadArtifact]
}
