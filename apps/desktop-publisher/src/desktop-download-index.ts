/** 安装包和原生更新源确认后才发布公开索引；同版合并目标，拒绝回退或替换同版字节。 */
import { gt } from 'semver'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { parseDesktopDownloadIndex, type DesktopDownloadIndex } from '@deepseek-ai/dsh-host-harness-product/downloads'
import type { DesktopUploadPlan } from './desktop-upload-types.ts'
import { desktopArtifactDigest, DesktopPublishError, type DesktopPublishOperations } from './desktop-publish.ts'

async function prepareIndex(plan: DesktopUploadPlan, operations: DesktopPublishOperations, verifyRemoteInstaller: boolean) {
  const publication = plan.downloadIndex
  if (publication === undefined) return
  const installer = plan.artifacts.find(file => file.key === publication.installerKey && !file.channelMetadata)
  if (installer === undefined) throw new DesktopPublishError('invalid-plan', 'desktop publish: download installer is outside the plan')
  const sha256 = createHash('sha256')
  for await (const bytes of createReadStream(installer.path) as AsyncIterable<Buffer>) sha256.update(bytes)
  if (sha256.digest('hex') !== publication.file.sha256) throw new DesktopPublishError('invalid-plan',
    'desktop publish: installer changed after validation')
  const expected = await desktopArtifactDigest(installer)
  if (expected.size !== publication.file.bytes) throw new DesktopPublishError('invalid-plan',
    'desktop publish: installer size differs from the download index')
  if (verifyRemoteInstaller) {
    const remoteInstaller = await operations.transport.read(installer.key, false)
    if (remoteInstaller === null || remoteInstaller.size !== expected.size || remoteInstaller.sha512 !== expected.sha512) {
      throw new DesktopPublishError('verification-failed', 'desktop publish: installer readback differs')
    }
  }
  const remote = await operations.transport.read(publication.key, true)
  let previous: DesktopDownloadIndex | undefined
  if (remote !== null) {
    if (remote.contents === undefined) throw new DesktopPublishError('verification-failed',
      'desktop publish: download index bytes are unavailable')
    previous = parseDesktopDownloadIndex(JSON.parse(remote.contents), publication.deployment)
    if (gt(previous.version, plan.version)) throw new DesktopPublishError('superseded', 'desktop publish: a newer download index exists')
  }
  const files = previous?.version === plan.version ? previous.files.filter(file => file.target !== publication.file.target) : []
  const sameTarget = previous?.version === plan.version ? previous.files.find(file => file.target === publication.file.target) : undefined
  if (sameTarget !== undefined && (sameTarget.url !== publication.file.url ||
    sameTarget.filename !== publication.file.filename || sameTarget.bytes !== publication.file.bytes ||
      sameTarget.sha256 !== publication.file.sha256)) {
    throw new DesktopPublishError('conflict', 'desktop publish: same version installer differs from the download index')
  }
  const index = parseDesktopDownloadIndex({ schemaVersion: 1, product: 'agent-assistant',
    appId: publication.deployment.desktop.appId, environment: publication.deployment.environment,
    channel: 'stable', version: plan.version,
    publishedAt: previous?.version === plan.version ? previous.publishedAt : new Date().toISOString(),
    files: [...files, publication.file].sort((left, right) => left.target.localeCompare(right.target)),
  }, publication.deployment)
  const contents = `${JSON.stringify(index, null, 2)}\n`
  const artifact = { path: '', filename: publication.key.split('/').at(-1) ?? publication.key, key: publication.key,
    contentType: 'application/json', channelMetadata: true, contents }
  const digest = await desktopArtifactDigest(artifact)
  return { publication, remote, contents, artifact, digest }
}

/**
 * 写入原生产物或频道前拒绝过期索引、同版冲突与变更的本地文件；不要求安装包已上传。
 * @param plan - 将要发布的同一份构建计划。
 * @param operations - 持有跨机器索引锁的只读传输及记录器。
 * @returns 所有索引前置条件已验证，不产生远端写入。
 */
export async function preflightDesktopDownloadIndex(plan: DesktopUploadPlan, operations: DesktopPublishOperations): Promise<void> {
  await prepareIndex(plan, operations, false)
}

/**
 * 调用方必须持有跨机器索引锁；失败保留已上传文件，不报告完整发布。
 * @param plan - 已完成原生更新源发布的同一份构建计划。
 * @param operations - 限定对象键的传输和持久化记录器。
 * @returns 索引已按远端字节确认；无索引的历史计划不产生额外写入。
 */
export async function publishDesktopDownloadIndex(plan: DesktopUploadPlan, operations: DesktopPublishOperations): Promise<void> {
  const prepared = await prepareIndex(plan, operations, true)
  if (prepared === undefined) return
  const { publication, remote, contents, artifact, digest } = prepared
  if (remote?.sha512 === digest.sha512 && remote.size === digest.size) return
  await operations.record({ type: 'put-intent', key: publication.key, before: remote?.contents ?? null, after: contents })
  await operations.transport.put(artifact, digest, false)
  const actual = await operations.transport.read(publication.key, true)
  if (actual?.sha512 !== digest.sha512 || actual.size !== digest.size) throw new DesktopPublishError('verification-failed',
    'desktop publish: download index readback differs')
  await operations.record({ type: 'put-verified', key: publication.key })
}
