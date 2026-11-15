/** 主进程拥有产品身份；窗口、Host 与目录锁只能属于一个登录代次。 */
import { HarnessAuthClient, HarnessAuthError, type HarnessLogin,
  type HarnessSession } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import { harnessUserHome, type HarnessConfig } from '@deepseek-ai/dsh-host-harness-product/config'
import { acquireHarnessUserHome, migrateHarnessUserHome } from '@deepseek-ai/dsh-host-harness-product/home'

/** 桌面唯一的产品生命周期状态。 */
export type DesktopProductPhase = 'signedOut' | 'authenticating' | 'starting' | 'active' | 'revalidating' | 'stopping' | 'unavailable' | 'stopFailed'
/** Renderer 可见的公开状态，不含中央 Token 或本机秘密。 */
export interface DesktopProductState {
  state: DesktopProductPhase
  generation: number
  authenticated: boolean
  user?: HarnessSession['user']
  expires_at?: string
  error?: { code: string; message: string }
}
/** 每个登录代次独占一个受管运行实例。 */
export interface DesktopProductRuntime {
  start(): Promise<void>
  stop(): Promise<void>
  observe(): void
  suspend(): void
  resume(): Promise<void>
  terminateOnExit(): void
}
interface Identity {
  generation: number
  login: HarnessLogin
  preparation: Promise<void>
  release?: () => Promise<void>
  runtime?: DesktopProductRuntime
}
/** 主进程提供的原生资源操作；block 必须同步撤回窗口和传输权限。 */
export interface DesktopProductSessionOptions {
  config: HarnessConfig
  createRuntime(login: HarnessLogin, generation: number, home: string, failed: (error: HarnessAuthError) => void): DesktopProductRuntime
  block(): void
  retire(): Promise<void>
  publish(state: DesktopProductState): void
}

/** 无持久化登录；所有异步结果验证当前代次后才允许改变运行身份。 */
export class DesktopProductSession {
  readonly auth: HarnessAuthClient
  private phase: DesktopProductPhase = 'signedOut'
  private generation = 0
  private identity: Identity | undefined
  private stopping: Promise<void> | undefined
  private failure: HarnessAuthError | undefined
  private readonly heartbeat: ReturnType<typeof setInterval>
  private lastRenew = -Infinity

  constructor(private readonly options: DesktopProductSessionOptions) {
    this.auth = new HarnessAuthClient(options.config)
    this.heartbeat = setInterval(() => {
      if (this.phase !== 'active') return
      try { this.identity?.runtime?.observe() }
      catch (_inspectionFailed) { this.invalidate(new HarnessAuthError(503, 'HARNESS_STOP_FAILED', '无法确认运行进程状态，请退出应用后重试')); return }
      void this.authorize().catch(() => undefined)
    }, options.config.auth.heartbeatIntervalMs)
    this.heartbeat.unref()
  }

  /** 当前唯一状态，调用方只获得公开账号信息。 */
  get state(): DesktopProductState {
    const login = this.identity?.login
    return { state: this.phase, generation: this.generation, authenticated: this.phase === 'active',
      ...(login === undefined || !['active','revalidating'].includes(this.phase) ? {} : { user: login.user, expires_at: login.expires_at }),
      ...(this.failure === undefined ? {} : { error: { code: this.failure.code, message: this.failure.message } }) }
  }

  private publish(): void { this.options.publish(this.state) }
  private assertCurrent(identity: Identity): void {
    if (this.identity !== identity || this.generation !== identity.generation) throw new HarnessAuthError(401,
      'HARNESS_LOGIN_CANCELLED', '本次登录已取消')
  }

  /**
   * 先认证并取得目录锁，之后才创建账号 Host。
   * @param body - 受限 IPC 已校验的登录字段。
   * @returns 当前公开产品状态。
   */
  async login(body: object): Promise<DesktopProductState> {
    if (!['signedOut','unavailable'].includes(this.phase) || this.stopping !== undefined) throw new HarnessAuthError(409,
      'HARNESS_INSTANCE_IN_USE', '当前登录或退出尚未完成')
    this.phase = 'authenticating'; this.failure = undefined
    const generation = ++this.generation
    this.lastRenew = -Infinity
    this.publish()
    let login: HarnessLogin | undefined
    try {
      login = await this.auth.login(body)
      if (generation !== this.generation) throw new HarnessAuthError(401, 'HARNESS_LOGIN_CANCELLED', '本次登录已取消')
      const identity: Identity = { generation, login, preparation: Promise.resolve() }
      this.identity = identity
      this.phase = 'starting'; this.publish()
      identity.preparation = (async () => {
        identity.release = await acquireHarnessUserHome(this.options.config, login.user.user_id, () => {
          if (this.identity === identity) this.invalidate(new HarnessAuthError(503, 'HARNESS_HOME_LOCK_LOST', '账号目录锁已失效，请重新登录'))
        })
        this.assertCurrent(identity)
        migrateHarnessUserHome(this.options.config, login.user.user_id)
        identity.runtime = this.options.createRuntime(identity.login, generation, harnessUserHome(this.options.config,
          login.user.user_id), (error) => {
          if (this.identity === identity) this.invalidate(error)
        })
      })()
      await identity.preparation
      this.assertCurrent(identity)
      if (identity.runtime === undefined) throw new HarnessAuthError(503, 'HARNESS_START_FAILED', '运行服务启动失败')
      await identity.runtime.start()
      this.assertCurrent(identity)
      const verified = await this.auth.session(login.access_token)
      this.assertCurrent(identity)
      this.assertSession(identity, verified)
      identity.login = { ...identity.login, ...verified }
      this.phase = 'active'; this.publish()
      return this.state
    } catch (error) {
      if (generation === this.generation) {
        this.failure = this.authError(error)
        await this.stop()
      }
      if (login !== undefined) await this.revoke(login.access_token)
      throw this.authError(error)
    }
  }

  private authError(error: unknown): HarnessAuthError {
    return error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_RUNTIME_UNAVAILABLE', '运行服务暂不可用，请重新登录')
  }
  private assertSession(identity: Identity, session: HarnessSession): void {
    if (session.user.user_id !== identity.login.user.user_id ||
      session.session_id !== identity.login.session_id) throw new HarnessAuthError(401, 'HARNESS_IDENTITY_CHANGED', '认证服务身份不一致，请重新登录')
  }

  /**
   * 每次业务 IPC 独立确认中央身份，返回后调用方仍核对原窗口。
   * @param renew - 是否为可信用户活动的续期。
   * @returns 已验证的公开状态。
   */
  async authorize(renew = false): Promise<DesktopProductState> {
    const identity = this.identity
    if (identity === undefined || !['active',
      'revalidating'].includes(this.phase)) throw this.failure ?? new HarnessAuthError(401, 'HARNESS_LOGIN_REQUIRED', '请先登录')
    try {
      const session = await this.auth.session(identity.login.access_token, renew)
      this.assertCurrent(identity); this.assertSession(identity, session)
      identity.login = { ...identity.login, ...session }
      return this.state
    } catch (error) {
      if (this.identity === identity && this.generation === identity.generation) this.invalidate(this.authError(error))
      throw this.authError(error)
    }
  }

  /** 只由已验证主 frame 的可信输入调用；后台事件不续期。 */
  async activity(): Promise<void> {
    if (this.phase !== 'active' || performance.now() - this.lastRenew < 15_000) return
    this.lastRenew = performance.now()
    await this.authorize(true)
  }

  /** 休眠先同步关闭新操作，再让 Host 暂停新的执行边界。 */
  suspend(): void {
    if (this.phase !== 'active') return
    this.phase = 'revalidating'; this.publish()
    this.identity?.runtime?.suspend()
  }

  /** 唤醒后主进程和 Host 分别重新验证，失败不恢复旧运行。 */
  async resume(): Promise<void> {
    if (this.phase !== 'revalidating') return
    const identity = this.identity
    if (identity === undefined) return
    try {
      await this.authorize(); this.assertCurrent(identity)
      await identity.runtime?.resume(); this.assertCurrent(identity)
      this.phase = 'active'; this.publish()
    } catch (error) { if (this.identity === identity && this.generation === identity.generation) this.invalidate(this.authError(error)) }
  }

  /**
   * 同步失效，异步停止失败时保留目录锁并禁止新登录。
   * @param error - 中央或受管进程的结构化失败。
   */
  invalidate(error: HarnessAuthError): void {
    if (['stopping','stopFailed','signedOut','unavailable'].includes(this.phase)) return
    this.failure = error
    void this.stop().catch(() => undefined)
  }

  /**
   * 本地先退出，远端撤销结果单独反馈。
   * @returns 中央退出是否确认。
   */
  async logout(): Promise<{ remote_confirmed: boolean }> {
    const token = this.identity?.login.access_token
    await this.stop()
    const confirmed = token === undefined || await this.revoke(token)
    if (!confirmed) { this.failure = new HarnessAuthError(503, 'HARNESS_REMOTE_LOGOUT_UNCONFIRMED', '本机已退出，远端退出未确认'); this.publish() }
    return { remote_confirmed: confirmed }
  }

  private async revoke(token: string): Promise<boolean> {
    try { await this.auth.request('/auth/logout', 'POST', undefined, token); return true }
    catch (_remoteUnavailable) { return false }
  }

  /**
   * 合并停止；锁只在 Host、后代及旧 Renderer 均停止后释放。
   * @returns 已确认本地资源停止；拒绝代表锁继续保留。
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    ++this.generation; this.phase = 'stopping'
    this.options.block(); this.publish()
    const identity = this.identity
    this.stopping = (async () => {
      await identity?.preparation.catch(() => undefined)
      await Promise.all([identity?.runtime?.stop(), this.options.retire()])
      await identity?.release?.()
      this.identity = undefined
      this.phase = this.failure === undefined ? 'signedOut' : 'unavailable'
      this.publish()
    })().catch((error: unknown) => {
      this.phase = 'stopFailed'; this.failure = new HarnessAuthError(503, 'HARNESS_STOP_FAILED', '运行服务未能确认停止，请退出应用并核对本地进程')
      this.publish(); throw error
    }).finally(() => { this.stopping = undefined })
    return this.stopping
  }

  /** 应用退出时停止心跳；正常退出仍须等待 stop 确认。 */
  dispose(): void { clearInterval(this.heartbeat) }
  /** 主进程同步退出时通知本代 Host；Host 同时监听 IPC 断开。 */
  terminateOnExit(): void { this.identity?.runtime?.terminateOnExit() }
}
