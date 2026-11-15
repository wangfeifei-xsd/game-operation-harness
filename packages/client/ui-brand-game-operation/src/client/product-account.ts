/** 载体拥有产品账号状态、可信活动和退出导航，组件只读取公开快照。 */
import { createWebAuthTransport, LocalAuthError, copy, type AuthOperation, type AuthTransport,
  type LocalSession } from '@deepseek-ai/dsh-client-ui-harness-account'

interface Bridge {
  request(operation: string,
    body?: object): Promise<{ ok: true; value: unknown } | { ok: false; error: { status: number; message: string } }>
  subscribe(listener: (state: LocalSession) => void): () => void
}

/** 每次插件装配独立拥有账号摘要与订阅。 */
export class ProductAccount {
  /** 账号传输是否由桌面主进程提供。 */
  readonly desktop: boolean
  /** 仅提供固定账号操作的当前载体传输。 */
  readonly transport: AuthTransport
  private snapshot: LocalSession = { authenticated: false }
  private readonly listeners = new Set<() => void>()
  private readonly bridge: Bridge | undefined
  /** 框架绑定为 useAccount；相同状态保持同一个快照引用。 */
  readonly state = { getSnapshot: () => this.snapshot, subscribe: (listener: () => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener) }
  } }

  constructor() {
    this.bridge = (window as Window & { agentAssistantAccount?: Bridge }).agentAssistantAccount
    this.desktop = this.bridge !== undefined
    const bridge = this.bridge
    this.transport = bridge === undefined ? createWebAuthTransport() : { async request<T>(operation: AuthOperation,
      data?: object): Promise<T> {
      const reply = await bridge.request(operation, data)
      if (!reply.ok) throw new LocalAuthError(reply.error.status, reply.error.message)
      return reply.value as T
    } }
  }

  /**
   * Web 定时读取同源状态；桌面只订阅主进程，不增加中央心跳。
   * @returns 插件释放时撤销订阅与活动监听。
   */
  start(): () => void {
    let closed = false
    let lastRenew = -Infinity
    const update = (value: LocalSession): void => {
      if (closed) return
      this.snapshot = value
      for (const listener of this.listeners) listener()
      if (!this.desktop && !value.authenticated) location.replace('/harness/login')
    }
    const read = async (): Promise<void> => {
      try { update(await this.transport.request<LocalSession>('session')) }
      catch (_unavailable) { if (!closed && !this.desktop) location.replace('/harness/login') }
    }
    const release = this.bridge?.subscribe(update)
    const timer = this.desktop ? undefined : setInterval(() => { void read() }, 10_000)
    const activity = (event: Event): void => {
      if (closed || this.desktop || !event.isTrusted || performance.now() - lastRenew < 15_000) return
      lastRenew = performance.now()
      void this.transport.request('renew', {}).catch(() => { if (!closed) location.replace('/harness/login') })
    }
    void read()
    document.addEventListener('pointerdown', activity, true); document.addEventListener('keydown', activity, true)
    return () => {
      closed = true; clearInterval(timer); release?.(); this.listeners.clear()
      document.removeEventListener('pointerdown', activity, true); document.removeEventListener('keydown', activity, true)
    }
  }

  /** 载体退出后销毁窗口或导航到公开登录页，不保留旧账号内容。 */
  async logout(): Promise<void> {
    if (this.desktop) { await this.transport.request('logout', {}); return }
    try { await this.transport.request('logout', {}) }
    catch (_remoteUnconfirmed) { sessionStorage.setItem('harnessLogoutNotice', copy.remoteUnknown) }
    location.replace('/harness/login')
  }
}
