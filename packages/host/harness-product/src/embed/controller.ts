import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { HarnessConfig } from '../config.ts'
import { EmbedCloud, EmbedServiceError, HEARTBEAT_MS, LEASE_MS, MAX_FRAME, PROTOCOL, boundedText, fields } from './cloud.ts'
import { canonicalWorkspace, privateDirectory } from './files.ts'

interface Challenge {
  launch_id: string
  challenge: string
  business_name: string
  tenant_name: string
  entry: 'pc' | 'web' | 'standalone'
}
/** 已配对的单次业务会话及其本机能力。 */
export interface EmbedGrant {
  launch: string
  root: string
  workspace: string
  desktop: boolean
  agents: boolean
  signal: AbortSignal
  online(): boolean
  waitOnline(signal?: AbortSignal): Promise<void>
  request<T>(path: string, options?: Omit<NonNullable<Parameters<EmbedCloud['request']>[2]>, 'launch'>): Promise<T>
  emit(snapshot: object): void
}
/** 处理已配对会话的本机运行实例，由连接持有和释放。 */
export interface EmbedRuntime {
  request(operation: string, id: string, frame: Record<string, unknown>): Promise<unknown>
  dispose(): Promise<void>
}
/** 用已配对会话的权限和生命周期启动隔离的运行实例。 */
export type RuntimeFactory = (grant: EmbedGrant) => Promise<EmbedRuntime>

interface Pair {
  id: string
  challenge: Challenge
  until: number
}

const requestId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const launchId = /^helaunch_[0-9a-zA-Z_-]{1,120}$/u
const mutations = ['prompt', 'cancel', 'answer', 'upload', 'remote-resume', 'remote-cancel', 'remote-verify'] as const
type Mutation = typeof mutations[number]
type Receipt = { id: string; op: Mutation; state: 'pending' | 'completed' | 'failed'; error?: string }
type Operation = { digest: string; receipt: Receipt; result: Promise<unknown> }
type PairedDevice = { name: string; workspace: string; desktop: boolean; agents: boolean }

function actionableError(failure: unknown): string {
  return (failure instanceof Error ? failure.message : '本机操作未完成').slice(0, 240)
}

class Connection {
  readonly lifetime = new AbortController()
  private readonly operations = new Map<string, Operation>()
  private receiptRevision = 0
  private snapshot: object | undefined
  socket: WebSocket | undefined
  runtime: Promise<EmbedRuntime> | undefined
  state = 'confirm'
  error = ''
  until = 0
  private leaseUntil = 0
  private stopped: Promise<void> | undefined

  constructor(readonly cloud: EmbedCloud, readonly launch: string, readonly credential: string,
    readonly scope: Omit<EmbedGrant, 'launch' | 'signal' | 'online' | 'waitOnline' | 'request' | 'emit'>,
    readonly factory: RuntimeFactory, private readonly business: Omit<Challenge, 'challenge'>, private readonly device: PairedDevice, private readonly remember: (id: string) => Promise<void>) {}

  online = (): boolean => !this.lifetime.signal.aborted && this.socket?.readyState === WebSocket.OPEN
    && Date.now() < Math.min(this.until, this.leaseUntil)

  private updateLease(started: number, remaining: unknown): void {
    // 用发起请求的时刻估算截止时间，网络等待不会延长本机授权。
    const duration = typeof remaining === 'number' && Number.isInteger(remaining)
      ? Math.max(0, Math.min(LEASE_MS, remaining))
      : LEASE_MS
    this.leaseUntil = started + duration
  }

  private async waitOnline(signal?: AbortSignal): Promise<void> {
    const lifetime = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    while (!this.online()) await delay(250, undefined, { signal: lifetime })
    lifetime.throwIfAborted()
  }

  send(frame: object): void {
    const socket = this.socket
    if (!socket || !this.online()) return
    const raw = JSON.stringify(frame)
    if (Buffer.byteLength(raw) <= MAX_FRAME && socket.bufferedAmount < MAX_FRAME * 2) socket.send(raw)
  }

  stop(): Promise<void> {
    this.lifetime.abort()
    this.until = 0
    this.socket?.close()
    return this.stopped ??= (async () => { await (await this.runtime?.catch(() => undefined))?.dispose() })()
  }

  async run(): Promise<void> {
    const signal = this.lifetime.signal
    try {
      for (const deadline = Date.now() + 300_000;;) {
        const requested = Date.now()
        const status = await this.cloud.request<{ state: string; protocol: number; lease_ms?: number; remember?: string }>(
          `launches/${this.launch}?role=host`, this.credential, { signal })
        if (status.protocol !== PROTOCOL) throw new Error('请更新本机 Agent 助手')
        if (status.state === 'active') {
          this.updateLease(requested, status.lease_ms)
          if (status.remember) await this.remember(status.remember)
          break
        }
        if (Date.now() >= deadline) throw new Error('配对已过期，请重新配对')
        await delay(1500, undefined, { signal })
      }
      this.state = 'connecting'
      while (!signal.aborted && Date.now() < this.leaseUntil) {
        const closeCode = await this.connect()
        if (closeCode === 4406) throw new Error('请更新本机 Agent 助手')
        if (closeCode === 4403) throw new Error('业务授权已失效，请重新配对')
        await delay(Math.max(0, Math.min(1500, this.leaseUntil - Date.now())), undefined, { signal })
      }
      if (!signal.aborted) throw new Error('连接已结束，请重新配对')
    } catch (failure) {
      if (!signal.aborted) {
        this.state = 'closed'
        this.error = failure instanceof EmbedServiceError || failure instanceof Error ? failure.message : '连接未完成'
      }
    } finally {
      await this.stop()
    }
  }

  private connect(): Promise<number> {
    const authenticatedAt = Date.now()
    const socket = this.cloud.socket()
    this.socket = socket
    const signal = this.lifetime.signal
    let lastPong = Date.now()
    let ready = false
    let wasOnline = false
    let pingAt: number | undefined
    return new Promise((resolve) => {
      const abort = (): void => { socket.close() }
      let leaseTimer: ReturnType<typeof setTimeout>
      const guardLease = (): void => {
        clearTimeout(leaseTimer)
        leaseTimer = setTimeout(abort, Math.max(0, this.leaseUntil - Date.now()))
      }
      const ping = (): void => {
        if (pingAt !== undefined || socket.readyState !== WebSocket.OPEN) return
        pingAt = Date.now()
        socket.send(JSON.stringify({ type: 'ping' }))
      }
      guardLease()
      const timer = setInterval(() => {
        const now = Date.now()
        if (now - lastPong >= LEASE_MS || now >= this.leaseUntil) {
          socket.close()
          return
        }
        if (wasOnline && !this.online()) this.disconnect()
        if (ready) ping()
      }, HEARTBEAT_MS)
      signal.addEventListener('abort', abort, { once: true })
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'authenticate', role: 'host', protocol: PROTOCOL,
          launch_id: this.launch, credential: this.credential }))
      })
      socket.addEventListener('message', (event) => {
        if (signal.aborted || this.socket !== socket || typeof event.data !== 'string'
          || Buffer.byteLength(event.data) > MAX_FRAME) return
        try {
          const frame = fields(JSON.parse(event.data))
          if (!ready && frame.type === 'ready' && frame.protocol === PROTOCOL) {
            this.updateLease(authenticatedAt, frame.lease_ms)
            guardLease()
            ready = true
            ping()
          } else if (ready && frame.type === 'pong' && pingAt !== undefined) {
            this.updateLease(pingAt, frame.lease_ms)
            pingAt = undefined
            guardLease()
            lastPong = Date.now()
            if (frame.online === true) {
              this.until = lastPong + HEARTBEAT_MS * 2
              this.state = 'active'
              wasOnline = true
            } else if (wasOnline) {
              this.disconnect()
              wasOnline = false
            }
          } else if (this.online() && frame.type === 'request') {
            void this.handle(frame)
          }
        } catch {
          socket.close()
        }
      })
      socket.addEventListener('error', () => { socket.close() })
      socket.addEventListener('close', (event) => {
        clearInterval(timer)
        clearTimeout(leaseTimer)
        signal.removeEventListener('abort', abort)
        this.disconnect()
        resolve(event.code)
      }, { once: true })
      if (signal.aborted) abort()
    })
  }

  private disconnect(): void {
    this.until = 0
    this.snapshot = undefined
    if (this.state === 'active') this.state = 'connecting'
  }

  private receipts(): object {
    const entries = [...this.operations.values()].map(entry => entry.receipt)
    const pending = entries.filter(entry => entry.state === 'pending')
    const settled = entries.filter(entry => entry.state !== 'pending').slice(-12)
    return { revision: this.receiptRevision, entries: [...pending, ...settled] }
  }

  private receiptChanged(): void {
    this.receiptRevision++
    this.send({ type: 'event', kind: 'receipts', receipts: this.receipts() })
  }

  private mutate(id: string, op: Mutation, frame: Record<string, unknown>, apply: () => Promise<unknown>): Promise<unknown> {
    // 回执由本机持有，换页后可读取同一操作的结果。只记录摘要和结果，不保留请求正文。
    const digest = createHash('sha256').update(JSON.stringify(frame)).digest('hex')
    const previous = this.operations.get(id)
    if (previous) {
      if (previous.digest !== digest) throw new Error('操作编号已被使用')
      return previous.result
    }
    if (this.operations.size >= 1024) throw new Error('本次对话已达到操作上限')
    if ([...this.operations.values()].filter(entry => entry.receipt.state === 'pending').length >= 16) {
      throw new Error('请等待当前操作完成')
    }
    const receipt: Receipt = { id, op, state: 'pending' }
    const result = Promise.resolve().then(apply).then((data) => {
      receipt.state = 'completed'
      this.receiptChanged()
      return data
    }, (failure: unknown) => {
      receipt.state = 'failed'
      receipt.error = actionableError(failure)
      this.receiptChanged()
      throw failure
    })
    this.operations.set(id, { digest, receipt, result })
    this.receiptChanged()
    return result
  }

  async localView(): Promise<object> {
    if (!this.online()) return { launch: this.launch, online: false }
    if (!this.snapshot) await this.execute({ type: 'request', id: randomUUID(), op: 'sync' })
    if (!this.online()) return { launch: this.launch, online: false }
    return { launch: this.launch, online: true, snapshot: this.snapshot, receipts: this.receipts(), status: {
      state: 'active', protocol: PROTOCOL, online: true, device: this.device,
      business_name: this.business.business_name, tenant_name: this.business.tenant_name,
    } }
  }

  async execute(frame: Record<string, unknown>): Promise<unknown> {
    const id = boundedText(frame.id, 37)
    const operation = boundedText(frame.op, 32)
    if (!requestId.test(id)) throw new Error('操作编号无效')
    if (!this.online()) throw new Error('业务连接已离线')
    const mutation = mutations.find(op => op === operation)
    if (operation !== 'sync' && operation !== 'download' && operation !== 'plugin' && mutation === undefined) {
      throw new Error('业务助手不支持此操作')
    }
    const apply = async (): Promise<unknown> => {
      const runtime = await (this.runtime ??= this.factory({
        ...this.scope,
        launch: this.launch,
        signal: this.lifetime.signal,
        online: this.online,
        waitOnline: signal => this.waitOnline(signal),
        request: (path, options = {}) => this.cloud.request(path, this.credential, {
          ...options, launch: this.launch,
          signal: options.signal === undefined ? this.lifetime.signal : AbortSignal.any([this.lifetime.signal, options.signal]),
        }),
        emit: (snapshot) => {
          this.snapshot = snapshot
          this.send({ type: 'event', kind: 'snapshot', snapshot })
        },
      }).catch((failure: unknown) => { this.runtime = undefined; throw failure }))
      if (!this.online()) throw new Error('业务连接已离线')
      return runtime.request(operation, id, frame)
    }
    const data = mutation === undefined ? await apply() : await this.mutate(id, mutation, frame, apply)
    return operation === 'sync' ? { receipts: this.receipts(), plugins: data } : data
  }

  private async handle(frame: Record<string, unknown>): Promise<void> {
    const id = boundedText(frame.id, 37)
    if (!requestId.test(id)) return
    try {
      this.send({ type: 'reply', id, ok: true, data: await this.execute(frame) })
    } catch (failure) {
      this.send({ type: 'reply', id, ok: false, error: actionableError(failure) })
    }
  }
}

async function deviceKey(directory: string): Promise<ReturnType<typeof createPrivateKey>> {
  const path = join(directory, 'device-key.pem')
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.nlink !== 1 || process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new Error('本机设备密钥权限无效')
    }
    return createPrivateKey(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const { privateKey } = generateKeyPairSync('ed25519')
    await writeFile(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 })
    return privateKey
  }
}

type Consent = { link: string; workspace: string; identity: string; desktop: boolean; agents: boolean }
type ClaimResult = { credential: string; scope_key: string }
const linkId = /^hdevice_[a-f0-9]{32}$/u

async function workspaceIdentity(path: string): Promise<string> {
  const stats = await lstat(path, { bigint: true })
  return `${stats.dev}:${stats.ino}`
}

async function readConsent(file: string): Promise<Consent | undefined> {
  try {
    const stats = await lstat(file)
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 4096 || process.platform !== 'win32' && (stats.mode & 0o077) !== 0) return
    const row = fields(JSON.parse(await readFile(file, 'utf8')))
    if (typeof row.link !== 'string' || !linkId.test(row.link) || typeof row.workspace !== 'string' ||
      typeof row.identity !== 'string' || typeof row.desktop !== 'boolean' || typeof row.agents !== 'boolean') return
    return { link: row.link, workspace: row.workspace, identity: row.identity, desktop: row.desktop, agents: row.agents }
  } catch { return undefined }
}

/**
 * 为本机公开入口协调配对及业务会话生命周期。
 * @param config - 当前本机部署及其 Creativity 地址。
 * @param home - 本机部署的数据根目录。
 * @param factory - 配对获准后创建隔离实例的工厂。
 * @returns 本机入口使用的配对操作及关闭接口。
 */
export function createHarnessEmbed(config: HarnessConfig, home: string, factory: RuntimeFactory): {
  request(action: string, input?: unknown, picker?: () => Promise<string | null>): Promise<unknown>
  close(): Promise<void>
} {
  const cloud = new EmbedCloud(config)
  const lifetime = new AbortController()
  const dataRoot = realpath(home).then(path => privateDirectory(path, 'business-assistant'))
  void dataRoot.catch(() => {})
  let pair: Pair | undefined
  let active: Connection | undefined
  let busy = false
  let generation = 0
  let stopping = Promise.resolve()
  let discovering: Promise<void> | undefined
  const consentFile = async () => join(await dataRoot, 'consent.json')

  const suspend = async (): Promise<void> => {
    generation++
    pair = undefined
    const session = active
    if (session === undefined) return
    active = undefined
    stopping = session.stop()
    await stopping
  }

  const device = (workspace: string, desktop: boolean, agents: boolean) => {
    const name = Array.from(hostname().trim() || '本机设备').slice(0, 128).join('')
    const chars = Array.from(workspace)
    const label = chars.length <= 128 ? workspace : '…' + chars.slice(-127).join('')
    const workspaceKey = createHash('sha256').update(workspace).digest('hex')
    return { name, workspace: label, desktop, agents, workspaceKey }
  }

  const proof = (key: Awaited<ReturnType<typeof deviceKey>>, selected: ReturnType<typeof device>, prefix: unknown[]) => {
    const { name, workspace, desktop, agents, workspaceKey } = selected
    const bytes = Buffer.from(JSON.stringify([...prefix, name, workspace, desktop, agents, workspaceKey]))
    return {
      device_name: name, workspace, desktop, agents, protocol: PROTOCOL, workspace_key: workspaceKey,
      device_key: createPublicKey(key).export({ format: 'jwk' }).x,
      signature: sign(null, bytes, key).toString('base64url'),
    }
  }

  const remember = async (consent: Consent, instance: number): Promise<void> => {
    const file = await consentFile()
    const samePairing = () => generation === instance && !lifetime.signal.aborted
    if (!linkId.test(consent.link) || !samePairing()) return
    const temp = file + '.' + randomUUID()
    try {
      await writeFile(temp, JSON.stringify(consent), { flag: 'wx', mode: 0o600 })
      if (samePairing()) await rename(temp, file)
    } finally { await rm(temp, { force: true }) }
  }

  const connect = async (id: string, result: ClaimResult, selection: Omit<Consent, 'link'>,
    instance: number, challenge: Omit<Challenge, 'challenge'>): Promise<void> => {
    if (!launchId.test(id) || !/^[a-f0-9]{64}$/u.test(result.scope_key) || !/^[A-Za-z0-9_-]{43}$/u.test(result.credential)) throw new Error('配对已失效')
    const root = await privateDirectory(await privateDirectory(await dataRoot, result.scope_key), id)
    await stopping
    if (generation !== instance || lifetime.signal.aborted) throw new Error('配对已失效')
    const { workspace, desktop, agents } = selection
    active = new Connection(cloud, id, result.credential, { root, workspace, desktop, agents }, factory,
      challenge, device(workspace, desktop, agents), link => remember({ ...selection, link }, instance))
    void active.run().catch(() => {})
  }

  const canDiscover = () => !busy && (!pair || Date.now() >= pair.until) && (!active || active.lifetime.signal.aborted)
  const discover = async (): Promise<void> => {
    if (!canDiscover()) return
    const instance = generation
    const file = await consentFile()
    const selection = await readConsent(file)
    if (selection === undefined) return
    const workspace = await canonicalWorkspace(selection.workspace, config.storage.root).catch(() => undefined)
    if (workspace !== selection.workspace || await workspaceIdentity(workspace) !== selection.identity) return
    const key = await deviceKey(await dataRoot)
    const timestamp = Math.floor(Date.now() / 1000)
    const nonce = randomBytes(32).toString('base64url')
    if (!canDiscover() || instance !== generation) return
    busy = true
    try {
      const result = await cloud.request<ClaimResult & Omit<Challenge, 'challenge'>>('pairing/reconnect', undefined, {
        body: { link_id: selection.link, timestamp, nonce, ...proof(key, device(workspace, selection.desktop, selection.agents),
          ['harness-embed-reconnect-v2', selection.link, timestamp, nonce]) },
        signal: lifetime.signal,
      })
      if (result.launch_id) await connect(result.launch_id, result, selection, instance, result)
    } catch (error) {
      if (error instanceof EmbedServiceError && error.status === 410 && generation === instance) await rm(file, { force: true })
    } finally { busy = false }
  }

  const timer = setInterval(() => {
    discovering ??= discover().catch(() => {}).finally(() => { discovering = undefined })
  }, HEARTBEAT_MS)
  timer.unref()

  const request = async (action: string, input?: unknown, picker?: () => Promise<string | null>): Promise<unknown> => {
    lifetime.signal.throwIfAborted()
    const body = fields(input)
    if (action === 'status') return { state: active?.state ?? 'idle', error: active?.error, workspace: active?.scope.workspace }
    if (action === 'chat') {
      const session = active
      if (input === undefined) return await session?.localView() ?? { online: false }
      if (!session || session.launch !== body.launch) throw new Error('业务会话已结束')
      return { data: await session.execute(fields(body.frame)) }
    }
    if (busy) throw new Error('请等待本机操作完成')
    busy = true
    const started = generation
    try {
      if (action === 'disconnect') {
        await suspend()
        await rm(await consentFile(), { force: true })
        return {}
      }
      if (action === 'lookup') {
        if (active && !active.lifetime.signal.aborted) throw new Error('请先断开当前业务助手')
        pair = undefined
        if (typeof body.code !== 'string' || !/^[A-Fa-f0-9]{8}$/u.test(body.code)) throw new Error('请输入八位配对码')
        const key = await deviceKey(await dataRoot)
        const challenge = await cloud.request<Challenge>('pairing/challenges', undefined, {
          body: { code: body.code, device_key: createPublicKey(key).export({ format: 'jwk' }).x }, signal: lifetime.signal,
        })
        if (generation !== started || !launchId.test(challenge.launch_id)) throw new Error('配对已失效')
        pair = { id: randomUUID(), challenge, until: Date.now() + 55_000 }
        return { id: pair.id, tenant: challenge.tenant_name, account: challenge.business_name, entry: challenge.entry,
          nativePicker: picker !== undefined }
      }
      if (!pair || pair.id !== body.id || Date.now() >= pair.until || started !== generation) throw new Error('配对已过期，请重新输入配对码')
      if (action === 'pick') {
        const until = pair.until
        const picked = await picker?.()
        if (!picked || generation !== started || Date.now() >= until) return { workspace: null }
        const workspace = await canonicalWorkspace(picked, config.storage.root)
        return { workspace }
      }
      if (action !== 'claim' || body.bindAccount === true) throw new Error('操作无效')
      const current = pair
      const workspace = await canonicalWorkspace(body.workspace, config.storage.root)
      const selection = {
        workspace, identity: await workspaceIdentity(workspace), desktop: body.desktop === true, agents: body.agents === true,
      }
      const key = await deviceKey(await dataRoot)
      const { launch_id: id, challenge } = current.challenge
      pair = undefined
      const result = await cloud.request<ClaimResult>(`launches/${id}/claim`, undefined, {
        body: { challenge, ...proof(key, device(workspace, selection.desktop, selection.agents), ['harness-embed-v2', id, challenge]) },
        signal: lifetime.signal,
      })
      await connect(id, result, selection, started, current.challenge)
      return { state: 'confirm' }
    } finally { busy = false }
  }
  return { request, close: async () => {
    clearInterval(timer)
    lifetime.abort()
    await suspend()
    await discovering
  } }
}
