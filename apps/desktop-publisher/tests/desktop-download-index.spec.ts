/** 同一发布记录的已确认字节决定公开索引；不同架构不能覆盖同版目标。 */
import '../../desktop/tests/product-deployment-fixture.ts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it, onTestFinished } from 'vitest'
import { desktopProductDeployment } from '../src/product-deployment.mjs'
import { publishDesktopRelease, type DesktopPublishOperations, type DesktopRemoteObject } from '../src/desktop-publish.ts'
import type { DesktopUploadPlan } from '../src/desktop-upload-types.ts'

function remote(contents: string): DesktopRemoteObject {
  return { contents, size: Buffer.byteLength(contents), sha512: createHash('sha512').update(contents).digest('base64') }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'desktop-index-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const filename = 'agent-assistant-1.0.0-win-x64.exe'
  const installer = { filename, path: join(root, filename), key: `agent-assistant/test/stable/bin/win-x64/${filename}`, contentType: 'application/octet-stream', channelMetadata: false }
  await writeFile(installer.path, 'installer')
  const objects = new Map<string, DesktopRemoteObject>()
  const writes: string[] = []
  const events: string[] = []
  const deployment = desktopProductDeployment({ DSH_DESKTOP_PRODUCT_ENVIRONMENT: 'test' })
  const indexKey = 'agent-assistant/test/stable/downloads.json'
  const plan: DesktopUploadPlan = { environment: 'test', target: 'win-x64', version: '1.0.0', bucket: 'fixture', secretIdEnvName: 'ID', secretKeyEnvName: 'KEY', publicUrl: 'https://updates.example.com/agent-assistant/test/stable/feeds/win-x64/', artifacts: [installer,
    { filename: 'stable.yml', path: '', key: 'agent-assistant/test/stable/feeds/win-x64/stable.yml', contents: 'version: 1.0.0\n', contentType: 'application/yaml', channelMetadata: true }],
  downloadIndex: { deployment, key: indexKey, installerKey: installer.key, file: { target: 'windows-x64', filename, bytes: 9,
    sha256: createHash('sha256').update('installer').digest('hex'), url: `https://updates.example.com/${installer.key}` } } }
  const operations: DesktopPublishOperations = {
    transport: {
      async read(key) { return objects.get(key) ?? null },
      async put(artifact) {
        writes.push(artifact.key)
        objects.set(artifact.key, remote(artifact.contents ?? await readFile(artifact.path, 'utf8')))
      },
    },
    async record(event) { events.push(event.type) }, async tag() {},
  }
  return { plan, operations, objects, writes, events, installer, indexKey }
}

it('publishes the index last and merges another architecture without dropping its bytes', async () => {
  const f = await fixture()
  const other = { target: 'macos-arm64', filename: 'agent-assistant-1.0.0-mac-arm64.dmg', bytes: 4, sha256: 'a'.repeat(64),
    url: 'https://updates.example.com/agent-assistant/test/stable/bin/mac-arm64/agent-assistant-1.0.0-mac-arm64.dmg' }
  f.objects.set(f.indexKey, remote(JSON.stringify({ schemaVersion: 1, product: 'agent-assistant', appId: f.plan.downloadIndex!.deployment.desktop.appId,
    environment: 'test', channel: 'stable', version: '1.0.0', publishedAt: '2026-11-16T00:00:00Z', files: [other] })))
  await expect(publishDesktopRelease(f.plan, f.operations)).resolves.toEqual({ status: 'complete' })
  expect(f.writes.at(-1)).toBe(f.indexKey)
  expect(JSON.parse(f.objects.get(f.indexKey)!.contents!)).toMatchObject({ files: [other, f.plan.downloadIndex!.file] })
  expect(f.events).toContain('feeds-complete')
  const writes = f.writes.length
  await publishDesktopRelease(f.plan, f.operations)
  expect(f.writes).toHaveLength(writes)
})

it.each(['local-change', 'remote-mismatch', 'same-version-conflict', 'newer-index'] as const)('does not announce complete publication for %s', async (kind) => {
  const f = await fixture()
  if (kind === 'local-change') await writeFile(f.installer.path, 'changed')
  if (kind === 'remote-mismatch') f.objects.set(f.installer.key, remote('wrong'))
  if (kind === 'same-version-conflict' || kind === 'newer-index') {
    const version = kind === 'newer-index' ? '2.0.0' : '1.0.0'
    f.objects.set(f.indexKey, remote(JSON.stringify({ schemaVersion: 1, product: 'agent-assistant', appId: f.plan.downloadIndex!.deployment.desktop.appId,
      environment: 'test', channel: 'stable', version, publishedAt: '2026-11-16T00:00:00Z', files: [{ ...f.plan.downloadIndex!.file,
        filename: `agent-assistant-${version}-win-x64.exe`, url: `https://updates.example.com/agent-assistant/test/stable/bin/win-x64/agent-assistant-${version}-win-x64.exe`, sha256: 'b'.repeat(64) }] })))
  }
  await expect(publishDesktopRelease(f.plan, f.operations)).rejects.toThrow()
  expect(f.writes).toEqual([])
  expect(f.events).not.toContain('feeds-complete')
})
