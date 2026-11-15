/** 按进程启动身份核对 Host 与已观察后代，确认停止后才能释放数据锁。 */
import type { ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createProcessInspector, type ProcessIdentity } from '@deepseek-ai/dsh-subprocess-local/process-inspector'
import { HarnessAuthError } from './auth-client.ts'

/** 单个 Host 的进程树，不会仅凭已复用的 PID 终止无关进程。 */
export class HarnessProcessTree {
  private readonly inspector = createProcessInspector()
  private readonly observed = new Map<string, ProcessIdentity>()
  private readonly exited: Promise<void>
  private didExit = false
  private readonly timer: ReturnType<typeof setInterval>
  private observationFailed = false

  constructor(private readonly child: ChildProcess) {
    this.exited = new Promise((resolve) => {
      const settle = (): void => { this.didExit = true; resolve() }
      child.once('exit', settle)
      child.once('error', () => { if (child.pid === undefined) settle() })
    })
    this.observe()
    this.timer = setInterval(() => {
      try { this.observe() } catch (_inspectionFailed) { this.observationFailed = true }
    }, 500)
    this.timer.unref()
  }

  /** 把带启动时间的后代归入当前 Host，保留已经脱离父树的受管进程。 */
  observe(): void {
    if (this.child.pid === undefined || this.didExit) return
    for (const identity of this.inspector.snapshot().tree(this.child.pid)) this.observed.set(`${identity.pid}:${identity.started}`, identity)
  }

  /**
   * 宽限截止前结束全部已识别进程，任何不确定结果都拒绝释放锁。
   * @param graceMs - 包含优雅停止与强制确认的总预算。
   * @param request - 发送私有停止指令。
   * @returns 是否在强制信号前完成 Host 退出。
   */
  async stop(graceMs: number, request: () => void): Promise<boolean> {
    const deadline = performance.now() + graceMs
    try { this.observe() } catch (_inspectionFailed) { this.observationFailed = true }
    request()
    let timer: ReturnType<typeof setTimeout> | undefined
    const graceful = await Promise.race([this.exited.then(() => true), new Promise<false>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, Math.max(1, graceMs - 750))
    })])
    clearTimeout(timer)
    try { this.observe() } catch (_inspectionFailed) { this.observationFailed = true }
    // 临时信号失败仍由随后存活核验决定；可重试停止，但观察缺口不能伪装已确认。
    for (const identity of this.observed.values()) {
      try { this.inspector.signalProcess(identity, 'SIGKILL') }
      catch (_signalFailed) { /* 最终进程表仍有该身份时保持锁，不把信号失败当成已停止。 */ }
    }
    if (!this.didExit && this.observed.size === 0) this.observationFailed = true
    while (performance.now() < deadline) {
      const snapshot = this.inspector.snapshot()
      if (this.didExit && [...this.observed.values()].every(identity => !snapshot.alive(identity)) && !this.observationFailed) {
        clearInterval(this.timer)
        return graceful
      }
      await delay(Math.min(25, Math.max(1, deadline - performance.now())))
    }
    clearInterval(this.timer)
    throw new HarnessAuthError(503, 'HARNESS_STOP_FAILED', '运行服务未能确认停止，请退出应用并核对本地进程')
  }

  /** 主进程同步退出阶段仍使用启动身份发出终止信号。 */
  terminateOnExit(): void {
    for (const identity of this.observed.values()) {
      try { this.inspector.signalProcess(identity, 'SIGKILL') }
      catch (_processAlreadyGone) { /* 正常停止继续负责确认；同步退出不能等待进程表。 */ }
    }
  }
}
