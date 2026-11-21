import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { EmbedGrant } from './controller.ts'
import { EmbedServiceError } from './cloud.ts'

interface AgentChoice {
  agent_code: string
  name: string
  input_schema: object
  output_schema: object
  conversation_enabled: boolean
}
interface Run {
  run_id: string
  state: string
  state_label: string
  current_step_name?: string
  result?: unknown
  error?: { message?: string }
}
interface Gate {
  interruption_id: string
  revision: number
  confirmation_digest: string
  name: string
  input_schema: object
  proposed_input: object
  can_respond: boolean
  can_approve: boolean
  can_verify: boolean
}
interface Admission {
  key: string
  name: string
  code: string
  session: string
  call: string
  conversation?: string
  state: 'submitting' | 'uncertain' | 'checking'
  resolve?: (run: AgentRun) => void
}
const finished = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
const waiting = new Set(['WAITING_INPUT', 'WAITING_APPROVAL'])

function keyFor(...parts: string[]): string {
  return 'embed_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)
}

class AgentRun {
  run?: Run
  gate: Gate | undefined
  busy = false
  cursor = 0
  notice = ''
  private readonly path: string
  constructor(readonly owner: EmbedGrant, readonly name: string, readonly admissionKey: string,
    readonly changed: () => void, runId: string) {
    this.path = `agent-runs/${runId}`
  }

  cancellable(): boolean {
    return this.run !== undefined && !finished.has(this.run.state) && this.run.state !== 'CANCEL_REQUESTED'
  }

  summary(): object | undefined {
    if (this.run === undefined && !this.notice) return undefined
    const gate = this.gate
    const prompt = gate === undefined ? this.notice || this.run?.current_step_name :
      `${gate.name}\n${JSON.stringify(this.run?.state === 'WAITING_INPUT' ? gate.input_schema : gate.proposed_input).slice(0, 6000)}`
    return { id: this.run?.run_id, name: this.name, state: this.notice || this.run?.state_label, prompt,
      cancellable: this.cancellable(),
      ...(gate && this.run ? { waiting: this.run.state, gate: gate.confirmation_digest,
        respond: gate.can_respond, approve: gate.can_approve, verify: gate.can_verify } : {}) }
  }

  async refresh(signal?: AbortSignal): Promise<Run> {
    const options = signal ? { signal } : undefined
    const run = await this.owner.request<Run>(this.path, options)
    const gate = waiting.has(run.state) ? await this.owner.request<Gate | null>(`${this.path}/interruption`, options) : null
    this.run = run
    this.gate = gate ?? undefined
    this.notice = ''
    this.changed()
    return run
  }

  async act(operation: string, id: string, frame: Record<string, unknown>): Promise<void> {
    if (this.busy) throw new Error('正在处理当前运行')
    this.busy = true
    try {
      if (operation === 'remote-cancel') {
        await this.owner.request(`${this.path}/cancel`, { body: {} })
      } else {
        const gate = this.gate
        if (!gate || frame.gate !== gate.confirmation_digest) throw new Error('该运行的待确认事项已变化')
        const decision = frame.decision
        const body = {
          interruption_id: gate.interruption_id, revision: gate.revision, confirmation_digest: gate.confirmation_digest,
          idempotency_key: keyFor(this.admissionKey, id), decision,
          input: {} as object,
        }
        if (decision === 'respond' && gate.can_respond) {
          if (typeof frame.text !== 'string' || frame.text.length > 16_000) throw new Error('请输入补充内容')
          try {
            const input = JSON.parse(frame.text) as unknown
            if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error()
            body.input = input
          } catch {
            throw new Error('请按本次输入格式填写 JSON 对象')
          }
        } else if (decision !== 'approve' && decision !== 'reject' && decision !== 'verify'
          || decision === 'verify' && !gate.can_verify
          || (decision === 'approve' || decision === 'reject') && !gate.can_approve) {
          throw new Error('当前运行不接受此操作')
        }
        await this.owner.request(`${this.path}/resume`, { body })
      }
      await this.refresh()
    } catch (failure) {
      this.notice = '待核查运行状态'
      this.changed()
      throw failure
    } finally {
      this.busy = false
    }
  }

  async follow(signal: AbortSignal): Promise<Run> {
    while (!signal.aborted && !this.owner.signal.aborted) {
      if (!this.owner.online()) { await delay(1000, undefined, { signal }); continue }
      try {
        const run = await this.refresh(signal)
        if (finished.has(run.state)) return run
        // 每次重连沿用原 run 和持久事件序号；流遇到撤权或断网会自动结束。
        const response = await this.owner.request<Response>(`${this.path}/events?after_sequence=${this.cursor}`, { sse: true, signal })
        const stream = response.body?.pipeThrough(new TextDecoderStream())
        if (stream === undefined) throw new Error('远端事件流缺失')
        let pending = ''
        for await (const chunk of stream) {
          pending += chunk
          if (pending.length > 2_000_000) throw new Error('远端事件超出大小限制')
          let boundary: number
          while ((boundary = pending.indexOf('\n\n')) >= 0) {
            const item = pending.slice(0, boundary)
            pending = pending.slice(boundary + 2)
            const cursor = /^id: (\d+)$/mu.exec(item)
            if (cursor) this.cursor = Number(cursor[1])
            if (/^event: control$/mu.test(item)) break
            if (cursor || item.startsWith(':')) {
              const current = await this.refresh(signal)
              if (finished.has(current.state)) return current
            }
          }
        }
      } catch (failure) {
        signal.throwIfAborted()
        this.owner.signal.throwIfAborted()
        this.notice = failure instanceof EmbedServiceError && failure.status === 403 ? '正在复核授权' : '待核查运行状态'
        this.changed()
      }
      await delay(1200, undefined, { signal })
    }
    throw new Error('智能体运行连接已结束')
  }
}

/** 为单次业务会话管理 Creativity 智能体调用和受理回执。 */
export class RemoteAgents {
  /** 当前已受理的云端运行。 */
  current: AgentRun | undefined
  private admission: Admission | undefined
  private active = false

  constructor(private readonly grant: EmbedGrant, private readonly changed: () => void) {}

  /**
   * 在会话明确允许 Creativity 智能体时安装目录与调用工具。
   * @param ctx - 持有该会话工具注册的插件上下文。
   */
  install(ctx: Context): void {
    if (!this.grant.agents) return
    ctx.inject(['tools'], (toolCtx) => {
      const textOutput = { schema: { type: 'string' } as const, render: (_args: unknown, text: string) => [{ type: 'text' as const, text }] }
      toolCtx.tools.register(defineTool({
        name: 'creativity_agents',
        description: '查看当前业务用户获准使用的 Creativity 智能体以及它们的输入、输出约定。',
        parameters: {},
        output: textOutput,
        execute: async (_args, execution) => JSON.stringify(await this.directory(execution.signal)),
      }))
      toolCtx.tools.register(defineTool({
        name: 'creativity_run_agent',
        description: '按 Creativity 智能体目录的输入约定提交一项业务子任务，只提交本次任务所需内容。主对话继续使用返回的业务结果。',
        parameters: {
          agent_code: { type: 'string', description: '从 creativity_agents 查询的智能体编号' },
          input_json: { type: 'string', description: '符合该智能体输入约定的 JSON 对象' },
        },
        output: textOutput,
        execute: async (args, execution) => {
          const session = execution.agent?.session.id
          if (!session) throw new Error('缺少本机业务会话')
          if (!args.agent_code || !args.input_json) throw new Error('缺少智能体或输入')
          return this.run(args.agent_code, args.input_json, session, execution.callId, execution.signal)
        },
      }))
    })
  }

  private directory(signal: AbortSignal): Promise<AgentChoice[]> {
    if (!this.grant.online()) throw new Error('业务连接已离线')
    return this.grant.request('agents', { signal })
  }

  /**
   * 为助手页读取当前云端运行或尚待核查的受理状态。
   * @returns 会话可展示的状态，没有运行或待核查项时返回空值。
   */
  summary(): object | undefined {
    const pending = this.admission
    if (!pending) return this.current?.summary()
    return { name: pending.name, state: pending.state === 'submitting' ? '正在提交' : '待核查受理结果',
      ...(pending.state === 'uncertain' && { admission: pending.key }) }
  }

  private lookup(pending: Admission): Promise<Run | null> {
    const query = new URLSearchParams({ agent_code: pending.code })
    if (pending.conversation) query.set('conversation_id', pending.conversation)
    return this.grant.request(`agent-runs/by-request?${query}`, { key: pending.key })
  }

  private async track(pending: Admission, run: Run): Promise<AgentRun> {
    if (!/^run_[a-zA-Z0-9_-]+$/u.test(run.run_id)) throw new Error('正在核查智能体运行标识')
    const selected = new AgentRun(this.grant, pending.name, pending.key, this.changed, run.run_id)
    selected.run = run
    this.current = selected
    // 先保留已确认的运行，登记文件失败也不能重新提交同一任务。
    this.admission = undefined
    pending.resolve?.(selected)
    this.changed()
    await writeFile(join(this.grant.root, `${pending.key}.json`), JSON.stringify({
      run_id: run.run_id, agent_code: pending.code, session: pending.session, call: pending.call,
    }), { mode: 0o600 }).catch(() => {
      selected.notice = '运行已受理，本机未能保存关联记录'
      this.changed()
    })
    return selected
  }

  /**
   * 查询尚未确认的原请求，不再次提交云端运行。
   * @param id - 当前待核查的请求标识。
   */
  async verify(id: unknown): Promise<void> {
    const pending = this.admission
    if (!pending || pending.key !== id || pending.state !== 'uncertain') throw new Error('当前待核查的调用已变化')
    pending.state = 'checking'
    this.changed()
    try {
      const run = await this.lookup(pending)
      if (!run) throw new Error('暂未查到受理回执，请稍后核查')
      await this.track(pending, run)
    } finally {
      if (this.admission === pending) pending.state = 'uncertain'
      this.changed()
    }
  }

  private waitForReceipt(pending: Admission, signal: AbortSignal): Promise<AgentRun> {
    const lifetime = AbortSignal.any([this.grant.signal, signal])
    lifetime.throwIfAborted()
    return new Promise((resolve, reject) => {
      const settle = (): void => {
        lifetime.removeEventListener('abort', abort)
        delete pending.resolve
      }
      const abort = (): void => { settle(); reject(new Error('业务操作已取消', { cause: lifetime.reason })) }
      lifetime.addEventListener('abort', abort, { once: true })
      pending.resolve = (run) => { settle(); resolve(run) }
    })
  }

  private async run(code: string, json: string, session: string, call: string, signal: AbortSignal): Promise<string> {
    if (this.admission) throw new Error('请先核查上一项智能体调用的受理结果')
    if (this.active || this.current?.run && !finished.has(this.current.run.state)) throw new Error('请先处理当前智能体运行')
    this.active = true
    const id = keyFor(this.grant.launch, session, call)
    try {
      if (json.length > 128_000) throw new Error('智能体输入过长')
      const input = JSON.parse(json) as unknown
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('智能体输入须为 JSON 对象')
      const agent = (await this.directory(signal)).find(item => item.agent_code === code)
      if (!agent) throw new Error('当前业务用户未获准使用该智能体')
      const conversation = agent.conversation_enabled ? await this.grant.request<{ conversation_id: string }>(
        'agent-conversations', { body: { agent_code: code, call_id: keyFor(this.grant.launch, session) }, signal }) : undefined
      const body = {
        agent_code: code, input, delivery: 'async',
        ...(conversation ? { conversation_id: conversation.conversation_id, client_message_id: id } : {}),
      }
      const pending: Admission = { key: id, name: agent.name, code, session, call, state: 'submitting',
        ...(conversation && { conversation: conversation.conversation_id }) }
      this.admission = pending
      this.changed()
      const submit = async (): Promise<Run> => {
        await this.grant.waitOnline(signal)
        return this.grant.request('agent-runs', { body, key: id, signal })
      }
      let receipt: Run | null = null
      try {
        receipt = await submit()
      } catch (failure) {
        if (!signal.aborted && failure instanceof EmbedServiceError && failure.status < 500) {
          this.admission = undefined
          throw failure
        }
        const canRetry = () => !signal.aborted && this.grant.online()
        if (canRetry()) {
          // 查询当前受理记录，同一工具调用只允许沿用原请求重发一次。
          receipt = await this.lookup(pending).catch(() => null)
          if (!receipt && canRetry()) receipt = await submit().catch(() => null)
        }
      }
      pending.state = 'uncertain'
      this.changed()
      const selected = receipt ? await this.track(pending, receipt) : await this.waitForReceipt(pending, signal)
      const run = await selected.follow(signal)
      return JSON.stringify({ state: run.state, result: run.result, error: run.error?.message })
    } finally {
      this.active = false
      this.changed()
    }
  }
}
