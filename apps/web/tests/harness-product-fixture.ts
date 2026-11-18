/** 两端产品入口共用的隔离认证服务与供应商；不替换产品 Host 或模型配置实现。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseHarnessConfig, type HarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'

/** 当前源码对应的已构建应用位置。 */
export const HARNESS_REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('测试端口未分配')
  return address.port
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
}

/** 实际到达供应商 HTTP 端点的调用。 */
export interface HarnessProviderCall { path: string; key: string; body: Record<string, unknown> }

/** 隔离运行数据、启动真实分发入口，并记录外部网络请求。 */
export class HarnessProductFixture {
  readonly calls: HarnessProviderCall[] = []
  readonly children: ChildProcess[] = []
  directory = ''
  origin = ''
  providerUrl = ''
  config!: HarnessConfig
  output = ''
  directoryStatus = 200
  private central!: Server
  private supplier!: Server
  private child: ChildProcess | undefined
  private readonly tokens = new Map<string, { user: string; id: string }>()

  /** 初始化文件配置与外部测试服务，尚不启动任何产品。 */
  async initialize(): Promise<void> {
    this.directory = await mkdtemp(join(tmpdir(), 'harness-model-product-'))
    this.central = createServer((request, response) => {
      void (async () => {
        response.setHeader('content-type', 'application/json')
        if (request.url === '/fixture/telemetry') { request.resume(); response.end('{}'); return }
        if (request.url?.endsWith('/bootstrap')) { response.end(JSON.stringify({ deployment_id: 'harness-dev', registration_enabled: true, password_min_length: 12, password_max_length: 256 })); return }
        if (request.url?.includes('/auth/captcha/')) {
          if (request.url.endsWith('/challenges')) {
            response.end(JSON.stringify({ challenge_id: 'fixture-challenge', background: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', piece: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp1sAAAAASUVORK5CYII=', piece_y: 20, piece_size: 40, width: 320, height: 160 })); return
          }
          response.end(JSON.stringify({ captcha_token: 'fixture-proof', expires_in: 120 })); return
        }
        if (request.url?.endsWith('/auth/register')) { response.writeHead(201); response.end(JSON.stringify({ registered: true })); return }
        if (request.url?.endsWith('/auth/logout')) { response.writeHead(204); response.end(); return }
        let record = this.tokens.get(request.headers.authorization?.slice(7) ?? '')
        let token: string | undefined
        if (request.url?.endsWith('/auth/login')) {
          const body = await readBody(request)
          const user = typeof body.login_name === 'string' ? body.login_name : 'alpha'
          token = randomBytes(32).toString('base64url')
          record = { user, id: `session_${this.tokens.size}` }
          this.tokens.set(token, record)
        }
        if (record === undefined) { response.writeHead(401); response.end('{}'); return }
        response.end(JSON.stringify({
          session_id: record.id, expires_in: 28000,
          expires_at: new Date(Date.now() + 28000_000).toISOString(),
          absolute_expires_at: new Date(Date.now() + 600000_000).toISOString(),
          user: { user_id: `user_${record.user}`, login_name: record.user, display_name: `用户 ${record.user}`, status: 'ACTIVE' },
          ...(token === undefined ? {} : { token_type: 'Bearer', access_token: token }),
        }))
      })().catch(() => { response.destroy() })
    })
    const centralPort = await listen(this.central)
    this.supplier = createServer((request, response) => {
      void (async () => {
        const body = await readBody(request)
        this.calls.push({ path: request.url ?? '', key: request.headers.authorization ?? '', body })
        if (request.url?.endsWith('/models')) {
          response.writeHead(this.directoryStatus, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const frame of [
          { choices: [{ index: 0, delta: { role: 'assistant', content: '模型调用成功' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
        ]) response.write(`data: ${JSON.stringify(frame)}\n\n`)
        response.end('data: [DONE]\n\n')
      })().catch(() => { response.destroy() })
    })
    this.providerUrl = `http://127.0.0.1:${await listen(this.supplier)}/v1`
    const reservation = createServer()
    const port = await listen(reservation)
    await new Promise<void>(resolve => reservation.close(() => { resolve() }))
    this.origin = `http://127.0.0.1:${port}`
    this.config = parseHarnessConfig(JSON.parse(await readFile(join(HARNESS_REPOSITORY, 'config/environments/dev.json'), 'utf8')), 'dev')
    this.config.server.port = port
    this.config.creativity.baseUrl = `http://127.0.0.1:${centralPort}`
    this.config.telemetry.url = `http://127.0.0.1:${centralPort}/fixture/telemetry`
    this.config.storage.root = join(this.directory, 'data/dev')
    this.config.providers.credentials = {}
    this.config.proxy = { http: null, https: null, noProxy: '*' }
    this.config.auth.heartbeatIntervalMs = 10_000
    this.config.desktop.updates = { enabled: false, url: null }
    this.config.desktop.mandatoryUpdate = { enabled: false, url: null }
    await mkdir(join(this.directory, 'config/environments'), { recursive: true })
    await writeFile(join(this.directory, 'config/environments/dev.json'), JSON.stringify(this.config))
  }

  /** 启动真实 harness 分发入口，使用隔离的部署文件。 */
  async startWeb(): Promise<void> {
    const cli = join(this.directory, 'apps/cli')
    await mkdir(cli, { recursive: true })
    await cp(join(HARNESS_REPOSITORY, 'apps/cli/lib'), join(cli, 'lib'), { recursive: true })
    await cp(join(HARNESS_REPOSITORY, 'apps/cli/package.json'), join(cli, 'package.json'))
    await symlink(join(HARNESS_REPOSITORY, 'apps/cli/node_modules'), join(cli, 'node_modules'), 'junction').catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
    })
    await writeFile(join(cli, 'lib/resources/environments/dev.json'), JSON.stringify(this.config))
    const child = spawn(process.execPath, [join(cli, 'lib/bin.js'), 'harness', '--environment', 'dev', '--no-open'], {
      cwd: this.directory, env: { ...process.env, DSH_HOME: join(this.directory, 'personal'), DSH_AGENTS_HOME: join(this.directory, 'personal-agents') }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.children.push(child); this.child = child
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => { reject(new Error(output || 'Harness 启动超时')) }, 30_000)
      const append = (bytes: Buffer): void => {
        output += bytes.toString(); this.output += bytes.toString()
        if (output.includes('Harness:')) { clearTimeout(timer); resolve() }
      }
      child.stdout?.on('data', append); child.stderr?.on('data', append)
      child.once('error', reject)
      child.once('exit', () => { clearTimeout(timer); reject(new Error(output || 'Harness 启动失败')) })
    })
  }

  /** 完全退出当前 Web Host，等待保存和生命周期释放。 */
  async stopWeb(): Promise<void> {
    if (this.child !== undefined) await this.stop(this.child)
    this.child = undefined
  }
  private async stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 10_000)
    child.kill('SIGTERM'); await exited; clearTimeout(timer)
  }
  /** 释放所有产品进程、网络连接和本次临时数据。 */
  async close(): Promise<void> {
    await Promise.all(this.children.map(child => this.stop(child)))
    for (const server of [this.central, this.supplier]) {
      if (server === undefined) continue
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
    if (this.directory !== '') await rm(this.directory, { recursive: true, force: true })
  }
}

/**
 * 在页面自身认证通道调用真实 Remote；桌面仍经过其私有协议与 Cookie。
 * @param page - 当前实际产品页面。
 * @param endpoint - Remote 方法名。
 * @param args - 该 Remote 的命名参数。
 * @returns Host 返回的完整操作结果。
 */
export async function productRemote<T>(page: Page, endpoint: string, args: object): Promise<RemoteResult<T>> {
  return page.evaluate(async ({ endpoint, args }) => {
    const response = await fetch(`/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: String(Date.now()) + Math.random().toString(36), method: endpoint, payload: { args } }),
    })
    if (!response.ok) throw new Error(`产品 Remote HTTP ${response.status}`)
    const envelope = await response.json() as { result: RemoteResult<T> }
    return envelope.result
  }, { endpoint, args })
}
