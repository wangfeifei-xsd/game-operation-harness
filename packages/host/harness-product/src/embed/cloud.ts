import type { HarnessConfig } from '../config.ts'

/** 设备签名与 Relay 使用同一版本的协议。 */
export const PROTOCOL = 2
/** 本机发送保活帧的间隔，单位为毫秒。 */
export const HEARTBEAT_MS = 5_000
/** 失去连接后允许保留本机步骤授权的最长时间，单位为毫秒。 */
export const LEASE_MS = 15_000
/** 单条 Relay 消息允许的最大字节数。 */
export const MAX_FRAME = 3 * 1024 * 1024

/** 只把凭据交给本机部署配置指定的 Creativity。 */
export class EmbedCloud {
  private readonly origin: URL
  constructor(private readonly config: HarnessConfig) {
    this.origin = new URL('/api/v1/harness/', config.creativity.baseUrl)
  }

  /**
   * 连接当前部署的 Relay。调用方负责首帧鉴权与关闭连接。
   * @returns 尚未完成鉴权的 WebSocket。
   */
  socket(): WebSocket {
    const url = new URL('relay', this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return new WebSocket(url)
  }

  /**
   * 调用指定部署的助手接口，将 HTTP 错误转换为不含响应正文的错误。
   * @param path - 助手接口的相对路径。
   * @param credential - 此接口要求的会话凭据，公开接口留空。
   * @param options - 请求正文、会话标识、幂等键、流响应标记及取消信号。
   * @returns 解析后的 JSON、流响应或空回执。
   */
  async request<T>(path: string, credential: string | undefined, options: {
    body?: object
    launch?: string
    key?: string
    sse?: boolean
    signal?: AbortSignal
  } = {}): Promise<T> {
    const headers = new Headers()
    if (credential !== undefined) headers.set('Authorization', `Bearer ${credential}`)
    if (options.launch !== undefined) headers.set('X-Harness-Launch', options.launch)
    if (options.key !== undefined) headers.set('Idempotency-Key', options.key)
    if (options.body !== undefined) headers.set('Content-Type', 'application/json')
    if (options.sse) headers.set('Accept', 'text/event-stream')
    const signal = options.sse ? options.signal : AbortSignal.any([
      AbortSignal.timeout(this.config.creativity.requestTimeoutMs),
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    const response = await fetch(new URL(path, this.origin), {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      ...(signal === undefined ? {} : { signal }),
      redirect: 'error',
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new EmbedServiceError(response.status)
    }
    if (options.sse) return response as T
    return (response.status === 204 ? undefined : await response.json()) as T
  }
}

/** 仅保留助手接口返回的状态及可展示的错误信息。 */
export class EmbedServiceError extends Error {
  constructor(readonly status: number) {
    super(status === 404 ? '业务助手未开放或请求已失效'
      : status === 401 || status === 403 ? '连接授权已失效'
        : status === 429 ? '操作过于频繁，请稍后再试' : '业务助手服务暂不可用')
  }
}

/**
 * 从未知输入读取对象字段。
 * @param value - 待检查的输入。
 * @returns 对象字段，其他输入返回空对象。
 */
export function fields(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * 读取有长度限制的文本字段。
 * @param value - 待检查的输入。
 * @param limit - 文本长度上限，以 UTF-16 代码单元计。
 * @returns 截短后的文本，其他输入返回空串。
 */
export function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}
