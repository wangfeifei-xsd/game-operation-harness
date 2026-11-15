/** 私有账号进程的 IPC 启动与有界停止，不通过 argv 或环境传递凭据。 */
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createProcessInspector, type ProcessIdentity } from '@deepseek-ai/dsh-subprocess-local'
import { HarnessAuthError, type HarnessUser } from './harness-auth-client.ts'
import type { HarnessConfig } from './harness-config.ts'

/** 仅通过父子 IPC 传送的一次启动身份。 */
export interface HarnessStart {
  kind: 'harness/start'
  generation: number
  token: string
  secret: string
  user: HarnessUser
}

function failureOf(message: unknown): HarnessAuthError {
  if (typeof message === 'object' && message !== null && 'error' in message
    && typeof message.error === 'object' && message.error !== null) {
    const error = message.error
    if ('status' in error && typeof error.status === 'number' && [401, 403, 503].includes(error.status)
      && 'code' in error && typeof error.code === 'string' && 'message' in error && typeof error.message === 'string') {
      return new HarnessAuthError(error.status, error.code, error.message)
    }
  }
  return new HarnessAuthError(503, 'HARNESS_RUNTIME_STOPPED', '运行服务已停止，请重新登录')
}

/** 父进程拥有的私有运行进程。 */
export class HarnessRuntimeProcess {
  private child: ChildProcess | undefined
  private readonly inspector = createProcessInspector()
  private readonly observed = new Map<string, ProcessIdentity>()
  private closed: Promise<void> = Promise.resolve()
  private stopping: Promise<void> | undefined
  private exited = false

  constructor(private readonly config: HarnessConfig, private readonly failed: (error?: HarnessAuthError) => void) {}

  /**
   * 启动同一 dsh 安装中的私有 profile，等待匹配本代的准备结果。
   * @param input - 已经中央认证的账号与内存秘密。
   * @returns 仅供 Node 代理访问的 loopback 地址。
   */
  async start(input: HarnessStart): Promise<string> {
    const source = import.meta.filename.endsWith('.ts')
    const entry = fileURLToPath(new URL(source ? './bin.ts' : './bin.js', import.meta.url))
    // 子进程保留操作系统启动条件，但不继承旧产品配置和供应商凭据。
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(DSH_|DEEPSEEK_|OPENAI_|ANTHROPIC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu.test(key)))
    const child = fork(entry, ['--profile', 'harness-runtime', '--environment', this.config.environment], {
      execArgv: source ? ['--import', 'tsx/esm'] : [],
      env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child = child
    child.on('message', (message: unknown) => {
      if (typeof message === 'object' && message !== null && 'kind' in message && message.kind === 'harness/failed'
        && 'generation' in message && message.generation === input.generation && this.stopping === undefined) this.failed(failureOf(message))
    })
    this.closed = new Promise((resolve) => {
      const settle = (): void => {
        if (this.exited) return
        this.exited = true
        resolve()
        if (this.stopping === undefined) this.failed()
      }
      child.once('exit', settle)
      child.once('error', () => { if (child.pid === undefined) settle() })
    })
    this.observe()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() =>{  finish(new HarnessAuthError(503, 'HARNESS_START_TIMEOUT', '运行服务启动超时，请重新登录')) }, 60_000)
      const finish = (result: Error | string): void => {
        clearTimeout(timer)
        child.off('message', onMessage)
        child.off('error', onError)
        child.off('exit', onExit)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      const onError = (): void => { finish(new HarnessAuthError(503, 'HARNESS_START_FAILED', '运行服务启动失败，请重新登录')) }
      const onExit = (): void => { onError() }
      const onMessage = (message: unknown): void => {
        if (typeof message !== 'object' || message === null || !('generation' in message) || message.generation !== input.generation || !('kind' in message)) return
        if (message.kind === 'harness/failed') { finish(failureOf(message)); return }
        if (message.kind !== 'harness/ready' || !('origin' in message) || typeof message.origin !== 'string') return
        let address: URL
        try { address = new URL(message.origin) }
        catch (_invalidOrigin) { onError(); return }
        if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.pathname !== '/' || address.search || address.hash || address.username || address.password) { onError(); return }
        finish(address.origin)
      }
      child.on('message', onMessage)
      child.once('error', onError)
      child.once('exit', onExit)
      child.send(input, (error) => { if (error !== null) onError() })
    })
  }

  /** 记录带启动身份的后代，停止时仍可识别已经脱离父树的受管进程。 */
  observe(): void {
    if (this.child?.pid === undefined || this.exited) return
    const snapshot = this.inspector.snapshot()
    for (const identity of snapshot.tree(this.child.pid)) this.observed.set(`${identity.pid}:${identity.started}`, identity)
  }

  /**
   * 先请求插件树正常释放，宽限到期后终止仍属于本代的进程。
   * @returns 在 Host 退出并完成后代终止后结束；失败时调用方必须保留目录锁。
   */
  stop(): Promise<void> {
    return this.stopping ??= this.stopOwned()
  }

  private async stopOwned(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    const deadline = performance.now() + this.config.auth.shutdownGraceMs
    let observationFailed = false
    const observe = (): void => {
      try { this.observe() }
      catch (_processTableUnavailable) { observationFailed = true }
    }
    observe()
    if (child.connected) child.send({ kind: 'harness/stop' }, () => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.closed, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(1, this.config.auth.shutdownGraceMs - 500))
    })])
    clearTimeout(timer)
    observe()
    for (const identity of this.observed.values()) {
      try { this.inspector.signalProcess(identity, 'SIGKILL') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') observationFailed = true }
    }
    if (!this.exited) child.kill('SIGKILL')
    // 发送终止信号不等于已经停止；确认后才允许协调器释放账号目录。
    while (performance.now() < deadline) {
      const snapshot = this.inspector.snapshot()
      if (this.exited && [...this.observed.values()].every(identity => !snapshot.alive(identity))) {
        if (observationFailed) break
        return
      }
      await delay(Math.min(25, Math.max(1, deadline - performance.now())))
    }
    throw new HarnessAuthError(503, 'HARNESS_STOP_FAILED', '运行服务未能确认停止，请关闭本地进程')
  }

  /** 父进程同步退出时发送停止信号；子进程同时监听 IPC 断开并自行清理。 */
  terminateOnExit(): void {
    if (this.child?.pid === undefined || this.exited) return
    this.child.kill('SIGTERM')
  }
}
