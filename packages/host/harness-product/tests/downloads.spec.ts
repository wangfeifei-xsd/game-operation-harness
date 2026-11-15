/** 下载索引必须匹配产品身份与真实目标；异常内容不会被公开入口当作链接。 */
import { afterEach, expect, it, vi } from 'vitest'
import { readHarnessConfig } from '../src/config.ts'
import { parseDesktopDownloadIndex, readDesktopDownloadIndex } from '../src/downloads.ts'
import { fileURLToPath } from 'node:url'

const config = readHarnessConfig('test', fileURLToPath(new URL('../../../../config/environments/', import.meta.url)))
config.desktop.downloadIndexUrl = 'https://downloads.example.com/agent-assistant/test/stable/downloads.json'
const file = { target: 'macos-arm64', filename: 'agent-assistant-1.2.3-mac-arm64.dmg',
  url: 'https://downloads.example.com/agent-assistant/test/stable/bin/mac-arm64/agent-assistant-1.2.3-mac-arm64.dmg',
  bytes: 1024, sha256: 'a'.repeat(64) }
const index = { schemaVersion: 1, product: 'agent-assistant', appId: config.desktop.appId, environment: 'test',
  channel: 'stable', version: '1.2.3', publishedAt: '2026-11-16T00:00:00Z', files: [file] }
afterEach(() => { vi.unstubAllGlobals() })

it('returns only published targets and never constructs an installer for a missing target', () => {
  expect(parseDesktopDownloadIndex(index, config).files).toEqual([file])
  expect(parseDesktopDownloadIndex({ ...index, files: [] }, config).files).toEqual([])
})
it.each([
  { environment: 'master' }, { product: 'deepseek-harness' }, { appId: 'another.application' }, { channel: 'nightly' },
  { files: [file, file] }, { files: [{ ...file, sha256: '' }] }, { files: [{ ...file, bytes: 0 }] },
  { files: [{ ...file, url: 'https://other.example.com/agent-assistant-1.2.3-mac-arm64.dmg' }] },
  { files: [{ ...file, url: file.url + '?token=secret' }] }, { files: [{ ...file, target: 'windows-x64' }] },
  { files: [{ ...file, filename: 'agent-assistant-1.2.3-mac-arm64-untrusted.dmg' }] },
])('rejects foreign or invalid index fields %j', (patch) => {
  expect(() => parseDesktopDownloadIndex({ ...index, ...patch }, config)).toThrow(expect.objectContaining({ code: 'HARNESS_DOWNLOAD_INVALID' }))
})
it('does not fetch an unconfigured source and bounds downloads without forwarding account headers', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(index))
  vi.stubGlobal('fetch', request)
  expect(await readDesktopDownloadIndex({ ...config, desktop: { ...config.desktop, downloadIndexUrl: null } })).toBeNull()
  expect(request).not.toHaveBeenCalled()
  expect(await readDesktopDownloadIndex(config)).toEqual(index)
  expect(request.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', cache: 'no-store' })
  expect(request.mock.calls[0]?.[1]).not.toHaveProperty('headers')
  request.mockResolvedValueOnce(new Response('x'.repeat(1_048_577)))
  await expect(readDesktopDownloadIndex(config)).rejects.toMatchObject({ code: 'HARNESS_DOWNLOAD_INVALID' })
})
