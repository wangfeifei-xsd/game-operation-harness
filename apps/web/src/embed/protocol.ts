import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { z } from 'zod'

/** 云端页面只通过父容器的专用端口取得一次性票据。 */
export const PROTOCOL = 2
const CONTAINER_PROTOCOL = 1
export const API = '/api/v1/harness'
export type Ticket = { launchId: string; ticket: string }
export type Status = {
  state: 'waiting' | 'confirm' | 'active'
  protocol: number
  pair_code: string | null
  business_name: string
  tenant_name: string
  device: { name: string; account: string; workspace: string; desktop: boolean; agents: boolean } | null
  online: boolean
}
type Attempt = { resolve: (value: Ticket) => void; reject: (error: Error) => void; timer: number }

export interface Startup {
  request(challenge: string, reset: boolean): Promise<Ticket>
  authenticated(launchId: string): void
  failed(): void
  close(unlink?: boolean): void
  dispose(): void
}

const item = z.object({
  id: z.string(), question: z.string(), detail: z.string().optional(),
  options: z.array(z.string()).optional(), multiSelect: z.boolean().optional(), custom: z.boolean().optional(),
})
const file = z.object({ id: z.string(), name: z.string() })
const plugin = file.extend({ revision: z.string() })
const message = z.object({ seq: z.number(), role: z.enum(['user', 'assistant']), text: z.string() })
export const snapshotSchema = z.object({
  messages: z.array(message),
  busy: z.boolean(),
  question: z.object({ id: z.string(), digest: z.string(), items: z.array(item) }).optional(),
  activity: z.string().optional(),
  files: z.array(file).optional(),
  plugins: z.array(plugin).optional(),
  remote: z.object({
    name: z.string(), state: z.string(), prompt: z.string().optional(),
    id: z.string().optional(), gate: z.string().optional(), admission: z.string().optional(),
    respond: z.boolean().optional(), approve: z.boolean().optional(), verify: z.boolean().optional(), cancellable: z.boolean().optional(),
  }).optional(),
})
const receipt = z.object({
  id: z.string(),
  op: z.enum(['prompt', 'cancel', 'answer', 'upload', 'remote-resume', 'remote-cancel', 'remote-verify']),
  state: z.enum(['pending', 'completed', 'failed']),
  error: z.string().optional(),
})
export const receiptsSchema = z.object({ revision: z.number(), entries: z.array(receipt) })
export type Snapshot = z.infer<typeof snapshotSchema>
export type Receipts = z.infer<typeof receiptsSchema>
export type EmbedPlugin = z.infer<typeof plugin>

export function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function messageText(value: unknown, fallback: string): string {
  return typeof value === 'string' && value ? value : fallback
}

export function relayFrame(data: unknown): Record<string, unknown> {
  if (typeof data !== 'string') return {}
  try { return fields(JSON.parse(data)) }
  catch { return {} }
}

export function openStartup(onExpired: () => void): Startup {
  const bridge = (window as Window & { harnessEmbed?: { ready(): void } }).harnessEmbed
  const origins = (import.meta.env.VITE_HARNESS_PARENT_ORIGINS as string | undefined ?? '').split(',').map(value => value.trim())
  const framed = window.parent !== window
  const parentOrigin = document.referrer ? new URL(document.referrer).origin : ''
  if (framed ? !origins.includes(parentOrigin) : !bridge) throw new Error('请从已登录的业务页面打开助手')
  const page = randomUUID()
  let port: MessagePort | undefined
  let pending: Attempt | undefined
  let waitForPort: (() => void) | undefined
  let disposed = false

  const settle = (result: Ticket | Error): void => {
    const request = pending
    pending = undefined
    waitForPort = undefined
    if (!request) return
    window.clearTimeout(request.timer)
    if (result instanceof Error) request.reject(result)
    else request.resolve(result)
  }
  const bind = (event: MessageEvent<unknown>): void => {
    const data = fields(event.data)
    const valid = framed
      ? event.source === window.parent && event.origin === parentOrigin && data.type === 'harness:port' && data.page === page
      : event.source === window && event.origin === window.location.origin && data.type === 'harness:desktop-port'
    if (disposed || port || !valid || data.protocol !== CONTAINER_PROTOCOL || event.ports.length !== 1) return
    const received = event.ports[0]
    if (!received) return
    port = received
    received.onmessage = (message: MessageEvent<unknown>) => {
      const data = fields(message.data)
      if (data.type === 'expired') { onExpired(); return }
      if (data.type === 'launch-error') {
        settle(new Error(data.resumed === true ? '原会话已失效，请重新配对' : '无法启动助手，请检查业务登录'))
        return
      }
      const { launchId, ticket } = data
      if (data.type === 'ticket' && typeof launchId === 'string' && typeof ticket === 'string' &&
          /^helaunch_[a-f0-9]{32}$/u.test(launchId) && /^[A-Za-z0-9_-]{43}$/u.test(ticket)) {
        settle({ launchId, ticket })
      }
    }
    waitForPort?.()
  }
  const greet = (): void => {
    if (port) return
    if (framed) window.parent.postMessage({ type: 'harness:ready', protocol: CONTAINER_PROTOCOL, page }, parentOrigin)
    else bridge?.ready()
  }
  window.addEventListener('message', bind)
  const interval = window.setInterval(greet, 800)
  greet()
  return {
    request: (challenge, reset) => new Promise((resolve, reject) => {
      if (disposed || pending) { reject(new Error('启动连接不可用')); return }
      const timer = window.setTimeout(() => { settle(new Error('业务页面未能启动助手')) }, 15_000)
      pending = { resolve, reject, timer }
      const send = (): void => port?.postMessage({ type: 'launch', challenge, reset })
      if (port) send()
      else waitForPort = send
    }),
    authenticated: launchId => port?.postMessage({ type: 'authenticated', launchId }),
    failed: () => port?.postMessage({ type: 'launch-failed' }),
    close: unlink => port?.postMessage({ type: 'close', unlink }),
    dispose() {
      disposed = true
      window.clearInterval(interval)
      window.removeEventListener('message', bind)
      port?.close()
      settle(new Error('助手已关闭'))
    },
  }
}

export async function api<T>(path: string, credential?: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(API + path, {
    method: payload === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null)
    throw new Error(messageText(fields(fields(failure).error).message, '助手暂不可用，请稍后重试'))
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export async function pageChallenge(): Promise<{ challenge: string; verifier: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = btoa(String.fromCharCode(...bytes)).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_')
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') }
}
