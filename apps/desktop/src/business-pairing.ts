/** 桌面主进程持有独立配对进程及本次本机请求。 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { HarnessProcessTree } from '@deepseek-ai/dsh-host-harness-product/process-tree'
import { HarnessAuthError } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import { desktopNodeEnvironment } from './node-environment.ts'

/** 公开配对进程无法启动普通桌面 Host，操作只通过私有消息通道。 */
export class DesktopBusinessPairing {
  private child: { process: ChildProcess; tree: HarnessProcessTree } | undefined
  private next = 0
  private readonly pending = new Map<number, (error: unknown, result?: unknown) => void>()
  private stopping: Promise<void> | undefined

  constructor(private readonly options: {
    node: string
    runtimeDir: string
    primaryRuntime: string
    environment: string
    configDirectory: string
    shutdownGraceMs: number
    env(): NodeJS.ProcessEnv
  }) {}

  private start(): ChildProcess {
    if (this.child) return this.child.process
    const { node, runtimeDir, primaryRuntime, environment, configDirectory } = this.options
    const entry = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
    const child = spawn(node, ['--expose-internals', entry, '--business-pairing',
      runtimeDir, primaryRuntime, environment, configDirectory], {
      env: desktopNodeEnvironment(node, undefined, Object.fromEntries(Object.entries(this.options.env())
        .filter(([key]) => !/^(DEEPSEEK_|OPENAI_|ANTHROPIC_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/iu.test(key)))),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    this.child = { process: child, tree: new HarnessProcessTree(child) }
    const retired = (): void => {
      if (this.child?.process !== child) return
      if (!this.stopping) {
        this.child.tree.terminateOnExit()
        this.child = undefined
      }
      for (const done of this.pending.values()) done(new Error('本机助手暂不可用'))
    }
    child.once('exit', retired)
    child.once('error', retired)
    child.on('message', (value: unknown) => {
      if (this.child?.process !== child || typeof value !== 'object' || value === null || !('requestId' in value)
        || typeof value.requestId !== 'number') return
      const done = this.pending.get(value.requestId)
      if (!done) return
      if ('result' in value) done(undefined, value.result)
      else done(new Error('error' in value && typeof value.error === 'string' ? value.error.slice(0, 240) : '本机操作未完成'))
    })
    return child
  }

  /** 向本机配对协调器提交固定操作。 */
  async request(action: string, body?: unknown): Promise<unknown> {
    if (this.stopping) await this.stopping
    if (this.pending.size >= 16) throw new HarnessAuthError(429, 'HARNESS_PAIRING_BUSY', '请等待本机操作完成')
    const child = this.start()
    const requestId = ++this.next
    return await new Promise((resolve, reject) => {
      const done = (error: unknown, result?: unknown): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (error) reject(new HarnessAuthError(409, 'HARNESS_PAIRING_DENIED',
          error instanceof Error ? error.message : '本机操作未完成'))
        else resolve(result)
      }
      const timer = setTimeout(() => { done(new Error('本机助手操作超时')) }, 12_000)
      this.pending.set(requestId, done)
      child.send({ type: 'pairing', requestId, action, body }, (error) => { if (error) done(new Error('本机助手暂不可用')) })
    })
  }

  /** 等待配对进程及已经启动的本机会话完成退出。 */
  async stop(): Promise<void> {
    if (this.stopping) { await this.stopping; return }
    const child = this.child
    if (!child) return
    this.stopping = child.tree.stop(this.options.shutdownGraceMs, () => {
      if (child.process.connected) child.process.send({ type: 'shutdown' }, () => {})
    }).then(() => {
      if (this.child === child) this.child = undefined
    })
    try { await this.stopping }
    finally { this.stopping = undefined }
  }

  /** 主进程同步退出时只终止本次启动的进程树。 */
  terminateOnExit(): void { this.child?.tree.terminateOnExit() }
}
