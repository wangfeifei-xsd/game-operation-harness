/** COS 独占锁串行化不同平台和机器的下载索引更新；未知写入结果保留锁供人工核对。 */
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type COS from 'cos-nodejs-sdk-v5'
import { createDesktopCos, DESKTOP_COS_REGION, type DesktopCosCredentials } from './desktop-cos.ts'
import { cosOperation } from './cos-operation.ts'
import type { DesktopUploadPlan } from './desktop-upload-types.ts'

/**
 * 使用禁止覆盖的锁对象保护整个发布；不会自动抢占超时锁或重试未知写入。
 * @param plan - 发布目的地及下载索引键。
 * @param credentials - 当前存储部署的凭据。
 * @param operation - 核验、上传更新源和索引的单次操作。
 * @param createClient - COS 客户端工厂，测试可使用隔离传输。
 * @returns 操作结果；锁获取或释放失败均使调用失败。
 */
export async function withDesktopIndexLock<T>(plan: DesktopUploadPlan, credentials: DesktopCosCredentials,
  operation: () => Promise<T>, createClient: (credentials: DesktopCosCredentials) => COS = createDesktopCos): Promise<T> {
  if (plan.downloadIndex === undefined) return operation()
  const cos = createClient(credentials)
  const key = `${plan.downloadIndex.key}.lock`
  const location = { Bucket: plan.bucket, Region: DESKTOP_COS_REGION, Key: key }
  const contents = Buffer.from(JSON.stringify({ owner: randomUUID(), target: plan.target, version: plan.version,
    startedAt: new Date().toISOString() }))
  const body = Readable.from([contents])
  try {
    await cosOperation(cos, 30_000, () => cos.putObject({ ...location, Body: body,
      ContentLength: contents.length, ContentType: 'application/json', Headers: {
        'x-cos-forbid-overwrite': 'true', 'Content-MD5': createHash('md5').update(contents).digest('base64'),
      } }))
  } catch (cause) {
    throw new Error(`desktop publish: download index is locked or lock outcome is unknown; inspect ${key}`, { cause })
  } finally { body.destroy() }
  try { return await operation() }
  finally {
    // 只释放本次确认创建的锁；中途被人工替换时保留它，避免放行另一个写入者。
    const result = await cosOperation(cos, 30_000, () => cos.getObject(location))
    const actual = typeof result.Body === 'string' ? Buffer.from(result.Body) : result.Body
    if (!Buffer.isBuffer(actual) || !actual.equals(contents)) throw new Error('desktop publish: download index lock owner changed')
    await cosOperation(cos, 30_000, () => cos.deleteObject(location))
  }
}
