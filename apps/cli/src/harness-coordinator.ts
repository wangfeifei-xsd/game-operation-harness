/** 一个公开实例同时拥有一个账号；异步结果受登录代次约束。 */
import { randomBytes } from 'node:crypto'
import { acquireHarnessUserHome } from '@deepseek-ai/dsh-host-harness-product/home'
import { sameHarnessSecret } from '@deepseek-ai/dsh-host-harness-product/secret'
import { HarnessAuthClient, HarnessAuthError, type HarnessLogin, type HarnessSession } from './harness-auth-client.ts'
import { type HarnessConfig } from './harness-config.ts'
import { HarnessRuntimeProcess } from './harness-runtime-process.ts'
import { migrateHarnessUserHome } from './harness-home.ts'

type State = 'idle' | 'authenticating' | 'starting' | 'active' | 'stopping' | 'unavailable'
interface Identity {
  generation: number
  cookie: string
  login: HarnessLogin
  secret: string
  origin?: string
  runtime?: HarnessRuntimeProcess
  release?: (() => Promise<void>) | undefined
}

export { sameHarnessSecret } from '@deepseek-ai/dsh-host-harness-product/secret'
/** 公开登录入口的账号和进程状态所有者。 */
export class HarnessCoordinator {
  readonly auth: HarnessAuthClient
  private state: State = 'idle'
  private generation = 0
  private identity: Identity | undefined
  private ownerCookie: string | undefined
  private stopping: Promise<void> | undefined
  private failure: HarnessAuthError | undefined

  constructor(private readonly config: HarnessConfig, private readonly closeConnections: () => void) {
    this.auth = new HarnessAuthClient(config)
  }

  /**
   * 同实例的其他浏览器不能替换或退出当前账号。
   * @param cookie - 当前浏览器本机凭据。
   */
  assertOwner(cookie: string | undefined): void {
    if (this.ownerCookie !== undefined && !sameHarnessSecret(cookie, this.ownerCookie)) throw new HarnessAuthError(409, 'HARNESS_INSTANCE_IN_USE', '此实例已被另一登录窗口占用')
  }

  /**
   * 登录、锁定账号目录、启动私有进程；晚到结果不能复活已退出身份。
   * @param body - 浏览器输入，继续由中央服务严格验证。
   * @param cookie - 先前由入口分配给该浏览器的随机凭据。
   * @returns 可公开的账号会话，不含中央 Token。
   */
  async login(body: unknown, cookie: string): Promise<HarnessSession> {
    this.assertOwner(cookie)
    if (!['idle', 'unavailable'].includes(this.state) || this.stopping !== undefined) throw new HarnessAuthError(409, 'HARNESS_INSTANCE_IN_USE', '当前登录或退出尚未完成')
    this.state = 'authenticating'
    this.ownerCookie = cookie
    this.failure = undefined
    const generation = ++this.generation
    let identity: Identity | undefined
    let login: HarnessLogin | undefined
    try {
      login = await this.auth.login(body)
      this.assertGeneration(generation)
      identity = { generation, cookie, login, secret: randomBytes(32).toString('base64url') }
      this.identity = identity
      const current = identity
      this.state = 'starting'
      identity.release = await acquireHarnessUserHome(this.config, login.user.user_id, () => { this.invalidate(current, new HarnessAuthError(503, 'HARNESS_HOME_LOCK_LOST', '账号数据目录锁已失效，请重新登录')) })
      this.assertGeneration(generation)
      migrateHarnessUserHome(this.config, login.user.user_id)
      identity.runtime = new HarnessRuntimeProcess(this.config, (error) => {
        this.invalidate(current, error ?? new HarnessAuthError(503, 'HARNESS_RUNTIME_STOPPED', '运行服务已停止，请重新登录'))
      })
      identity.origin = await identity.runtime.start({ kind: 'harness/start', generation, sessionId: login.session_id, token: login.access_token, secret: identity.secret, user: login.user })
      this.assertGeneration(generation)
      const verified = await this.auth.session(login.access_token)
      this.assertGeneration(generation)
      this.state = 'active'
      return verified
    } catch (error) {
      if (this.generation === generation) await this.stop()
      else {
        await identity?.runtime?.stop()
        const release = identity?.release
        if (identity !== undefined) identity.release = undefined
        await release?.()
      }
      // 签发但未能交付的会话也须撤销；失败时登记及 TTL 仍约束其有效期。
      if (login !== undefined) await this.auth.request('/auth/logout', 'POST', undefined, login.access_token).catch(() => undefined)
      throw error
    }
  }

  private assertGeneration(generation: number): void {
    if (this.generation !== generation) throw new HarnessAuthError(401, 'HARNESS_LOGIN_CANCELLED', '本次登录已取消')
  }

  /**
   * 每个请求独立向中央验证；不复用通过结果或在途 Promise。
   * @param cookie - 本机随机会话凭据。
   * @param renew - 仅真实用户活动调用续期。
   * @returns 当前身份及仅供 Node 代理使用的地址。
   */
  async authorize(cookie: string | undefined, renew = false): Promise<{ session: HarnessSession; origin: string; secret: string }> {
    this.assertOwner(cookie)
    const identity = this.identity
    if (this.state !== 'active' || identity?.origin === undefined || !sameHarnessSecret(cookie, identity.cookie)) throw this.failure ?? new HarnessAuthError(401, 'HARNESS_LOGIN_REQUIRED', '请先登录')
    try {
      const session = await this.auth.session(identity.login.access_token, renew)
      this.assertGeneration(identity.generation)
      if (session.user.user_id !== identity.login.user.user_id || session.session_id !== identity.login.session_id) throw new HarnessAuthError(503, 'HARNESS_IDENTITY_CHANGED', '认证服务身份不一致')
      return { session, origin: identity.origin, secret: identity.secret }
    } catch (error) {
      this.invalidate(identity, error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用'))
      throw error
    }
  }

  /**
   * 页面读取当前状态，活动账号仍执行一次中央验证。
   * @param cookie - 当前浏览器本机凭据。
   * @returns 不含秘密的显示状态。
   */
  async status(cookie: string | undefined): Promise<object> {
    this.assertOwner(cookie)
    if (this.state === 'active') return { authenticated: true, ...(await this.authorize(cookie)).session }
    return { authenticated: false, state: this.state,
      ...(this.failure === undefined ? {} : { error: { code: this.failure.code, message: this.failure.message } }) }
  }

  /** 不续期的心跳，并记录进程后代供停止时核对。 */
  async heartbeat(): Promise<void> {
    const identity = this.identity
    if (this.state !== 'active' || identity === undefined) return
    try { identity.runtime?.observe(); await this.authorize(identity.cookie) }
    catch (error) { this.invalidate(identity, error instanceof HarnessAuthError ? error : new HarnessAuthError(503, 'HARNESS_AUTH_UNAVAILABLE', '认证服务暂不可用')) }
  }

  private invalidate(identity: Identity, error: HarnessAuthError): void {
    if (this.identity !== identity || this.state === 'stopping') return
    this.failure = error
    void this.stop().catch(() => { this.failure = new HarnessAuthError(503, 'HARNESS_STOP_FAILED', '运行服务未能确认停止，请关闭本地进程') })
  }

  /**
   * 先停止本地访问和任务，再尝试远端撤销；结果保留远端是否确认的事实。
   * @param cookie - 当前浏览器本机凭据。
   * @returns 中央服务是否确认退出。
   */
  async logout(cookie: string | undefined): Promise<boolean> {
    this.assertOwner(cookie)
    const token = this.identity?.login.access_token
    await this.stop()
    if (token === undefined) return true
    try { await this.auth.request('/auth/logout', 'POST', undefined, token); return true }
    catch (_remoteUnavailable) { return false }
  }

  /**
   * 同步封闭入口并合并本代停止流程；停止完成后才释放目录锁。
   * @returns 本地进程与存储均已停止的确认。
   */
  stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping
    ++this.generation
    this.state = 'stopping'
    this.closeConnections()
    const identity = this.identity
    this.stopping = (async () => {
      await identity?.runtime?.stop()
      const release = identity?.release
      if (identity !== undefined) identity.release = undefined
      await release?.()
      this.identity = undefined
      this.ownerCookie = undefined
      this.state = this.failure === undefined ? 'idle' : 'unavailable'
    })().finally(() => { this.stopping = undefined })
    return this.stopping
  }

  /** 同步进程退出阶段通知本代 Host 终止。 */
  terminateOnExit(): void { this.identity?.runtime?.terminateOnExit() }
}
