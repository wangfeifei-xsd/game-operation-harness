/** 使用真实 COS SDK 在回环服务器验证锁的独占与确认释放，不访问发布存储。 */
import { expect, it } from 'vitest'
import { withDesktopIndexLock } from '../src/desktop-index-lock.ts'
import { createDesktopCos } from '../src/desktop-cos.ts'
import { answer, cosError, startCosLoopback } from './cos-loopback.ts'
import type { DesktopUploadPlan } from '../src/desktop-upload-types.ts'

const credentials = { secretId: 'fixture-id', secretKey: 'fixture-key' }
const plan: DesktopUploadPlan = { environment: 'test', target: 'win-x64', version: '1.0.0', bucket: 'fixture-1250000000',
  publicUrl: 'https://updates.example.com/feed/', secretIdEnvName: 'ID', secretKeyEnvName: 'KEY', artifacts: [],
  downloadIndex: { key: 'downloads.json', installerKey: 'installer.exe', deployment: { environment: 'test', desktop: {
    appId: 'fixture.app', channel: 'stable', downloadIndexUrl: 'https://updates.example.com/downloads.json' } },
  file: { target: 'windows-x64', url: 'https://updates.example.com/agent-assistant-1.0.0-win-x64.exe', filename: 'agent-assistant-1.0.0-win-x64.exe', bytes: 1, sha256: 'a'.repeat(64) } } }

it.each(['success', 'operation-failed', 'foreign-owner', 'already-locked'] as const)('keeps lock ownership for %s', async (kind) => {
  let stored: Buffer | undefined = kind === 'already-locked' ? Buffer.from('other owner') : undefined
  let calls = 0
  const server = await startCosLoopback((request, response) => {
    if (request.method === 'PUT') {
      expect(request.headers['x-cos-forbid-overwrite']).toBe('true')
      if (stored) answer(response, 409, cosError('ObjectAlreadyExists'))
      else { stored = request.body; answer(response) }
    } else if (request.method === 'GET') answer(response, 200, stored)
    else if (request.method === 'DELETE') { stored = undefined; answer(response) }
    else throw new Error('unexpected operation')
  })
  try {
    const result = withDesktopIndexLock(plan, credentials, async () => {
      calls++
      if (kind === 'foreign-owner') stored = Buffer.from('replaced owner')
      if (kind === 'operation-failed') throw new Error('operation failed')
      return 'complete'
    }, (value) => { const client = createDesktopCos(value, 500); server.redirect(client); return client })
    if (kind === 'success') await expect(result).resolves.toBe('complete')
    else await expect(result).rejects.toThrow()
    expect(calls).toBe(kind === 'already-locked' ? 0 : 1)
    const retained = kind === 'already-locked' || kind === 'foreign-owner'
    expect(stored === undefined).toBe(!retained)
    expect(server.requests.filter(request => request.method === 'PUT')).toHaveLength(1)
    expect(server.requests.filter(request => request.method === 'DELETE')).toHaveLength(retained ? 0 : 1)
  } finally { await server.close() }
})
