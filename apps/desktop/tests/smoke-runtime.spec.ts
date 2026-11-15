/** Packaged runtime HTTP authentication and Office skill probe results. */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { assertOfficeSkillsLoadable, smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const boundary = vi.hoisted(() => ({
  start: vi.fn<() => Promise<{ url: string; injections: []; authenticationCookie: string }>>(),
  stop: vi.fn(async () => {}),
  construct: vi.fn<(...args: unknown[]) => void>(),
  run: vi.fn<(_executable: string, _args: string[], _options: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>>(),
}))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    constructor(...args: unknown[]) { boundary.construct(...args) }
    start = boundary.start
    stop = boundary.stop
  },
}))
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return { ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(vi.fn(), { [promisify.custom]: boundary.run }) }
})
afterEach(() => {
  boundary.start.mockReset()
  boundary.stop.mockClear()
  boundary.construct.mockClear()
  boundary.run.mockReset()
  vi.restoreAllMocks()
})

const loadedSkills = [
  { name: 'office', bytes: 772 },
  { name: 'office-docx', bytes: 4543 },
  { name: 'office-pptx', bytes: 5167 },
  { name: 'office-xlsx', bytes: 5611 },
]

it('authenticates the fixed product Host, rejects anonymous access and refuses modified profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-auth-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    if (!isAbsolute(root) || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('dsh-smoke-auth-')) {
      throw new Error(`refusing unexpected fixture cleanup path: ${root}`)
    }
    await rm(root, { recursive: true, force: true })
  })
  const runtime = runtimeFixture(join(root, 'payload'))
  const resources = join(root, 'runtime')
  const primary = join(resources, 'primary-runtime')
  mkdirSync(primary, { recursive: true })
  writeFileSync(join(primary, 'runtime.json'), JSON.stringify({
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch, python: '3.12.0', pythonPackages: {},
  }))
  const secret = Buffer.alloc(32, 7).toString('base64url')
  const cookie = `dsh-desktop-session=${secret}`
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(Connection).await()
  await ctx.plugin(DesktopAuthentication, { readSecret: () => secret }).await()
  const requests: { path: string | undefined; cookie: string | undefined }[] = []
  ctx.on('webserver/request', async (request, _response, next) => {
    requests.push({ path: request.url, cookie: request.headers.cookie })
    await next()
  })
  ctx.effect(() => ctx.webServer.registerFallback({ handler(_request, response) { response.end('<html>packaged fixture</html>') } }))
  boundary.start.mockResolvedValueOnce({ url: ctx.webServer.getOrigin(), injections: [], authenticationCookie: cookie })
    .mockRejectedValueOnce(new Error('桌面产品插件配置被修改，请重新登录'))
  let smokeHome: string | undefined
  // 中央服务与 HTTP 凭据验证仍实际运行；只替代目标可执行程序。
  boundary.run.mockImplementation(async (_executable, args) => {
    smokeHome = args.at(-1)
    return { stdout: args.some(arg => arg.endsWith('runtime-office-smoke.mjs')) ? JSON.stringify(loadedSkills) : '', stderr: '' }
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await smokeDesktopRuntime(join(root, 'payload'), process.execPath, runtime, {}, resources)
  expect(requests).toEqual([{ path: '/', cookie: undefined }, { path: '/', cookie }])
  expect(boundary.construct).toHaveBeenCalledTimes(2)
  for (const args of boundary.construct.mock.calls) {
    expect(args[9]).toMatchObject({ version: 1, environment: 'dev', user: { user_id: 'desktop_smoke' } })
    expect(args[4]).not.toHaveProperty('token')
  }
  expect(boundary.stop).toHaveBeenCalledTimes(2)
  expect(smokeHome).toBeDefined()
  expect(existsSync(smokeHome!)).toBe(false)
})

describe('assertOfficeSkillsLoadable', () => {
  it('accepts all four Office skills with nonempty bodies and no path', () => {
    expect(() => { assertOfficeSkillsLoadable(loadedSkills) }).not.toThrow()
  })

  it('rejects an unlisted or empty Office skill and reports every result', () => {
    const results = loadedSkills.map(skill => skill.name === 'office-docx' ? { ...skill, bytes: 0 } : skill)
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('rejects results missing a bundled Office skill', () => {
    const results = loadedSkills.filter(skill => skill.name !== 'office-xlsx')
    expect(() => { assertOfficeSkillsLoadable(results) }).toThrow(
      `desktop runtime: packaged Office skills are not loadable: ${JSON.stringify(results)}`,
    )
  })

  it('ignores empty results for skills outside the bundled Office set', () => {
    expect(() => { assertOfficeSkillsLoadable([...loadedSkills, { name: 'other', bytes: 0 }]) }).not.toThrow()
  })
})
