import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type { RemoteAccessBinding, RemoteAccessDecision } from '@deepseek-ai/dsh-api-remote-access'
import type { SessionEventsPage } from '@deepseek-ai/dsh-api-session-controller/types'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { boundedText, fields } from './cloud.ts'
import type { EmbedGrant, EmbedRuntime } from './controller.ts'
import { MAX_FILE, privateDirectory, readScopedFile, within } from './files.ts'
import { RemoteAgents } from './remote-agent.ts'
import { EmbedPluginRegistry } from './plugins.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    'business-assistant': { readonly kind: 'business-assistant'; readonly launch: string }
  }
}

type Item = { id: string; question: string; detail?: string; options?: string[] | undefined; multiSelect?: boolean; custom?: boolean }
type Interaction = { id: string; digest: string; items: Item[] }
type Pending = { screen: Interaction; resolve(answer: AskUserQuestionAnswer): void }
type File = { id: string; name: string; path: string; attached: boolean }
const fileTools = new Set(['read', 'read_image', 'write', 'edit', 'glob', 'grep'])

function visibleText(value: unknown): string {
  const entry = fields(value)
  const content = entry.content ?? fields(entry.message).content
  if (!Array.isArray(content)) return ''
  return content.map(part => fields(part)).filter(part => part.type === 'text')
    .map(part => boundedText(part.text, 32_000)).join('\n').slice(0, 32_000)
}

/** 运行当前会话的对话与工具，所有新操作受本机配对和连接租约约束。 */
export class EmbedSession implements EmbedRuntime {
  private readonly id = randomUUID() as SessionId
  private readonly questions = new Map<string, Pending>()
  private readonly files = new Map<string, File>()
  private readonly outputs = new Map<string, { id: string; name: string; path: string }>()
  private readonly remote: RemoteAgents
  private readonly plugins = new EmbedPluginRegistry(() => { this.changed() })
  private ctx?: Context
  private peer?: PeerScope
  private uploadDirectory?: string
  private timer: NodeJS.Timeout | undefined
  private snapshotRevision = 0
  private publishedRevision = 0
  private running: Promise<void> | undefined
  private admitted = false
  private activePrompt = false
  private disposed = false

  constructor(private readonly grant: EmbedGrant) {
    this.remote = new RemoteAgents(grant, () => { this.changed() })
  }

  /**
   * 在插件开始任何模型或工具步骤前安装同一份会话租约。
   * @param ctx - 持有本次隔离运行服务的插件上下文。
   */
  install(ctx: Context): void {
    ctx.provide('harnessEmbedPlugins', this.plugins)
    this.remote.install(ctx)
    const waitOnline = (signal?: AbortSignal) => this.grant.waitOnline(signal)
    ctx.on('agent/pre-step', async (_event, next) => { await waitOnline(); return next() }, { global: true, prepend: true })
    ctx.on('llm/stream', async function* (_event, next) { await waitOnline(); yield* next() }, { global: true, prepend: true })
    ctx.inject(['tools'], (guardCtx) => {
      guardCtx.tools.guard(execution => !this.grant.online() ? '业务连接已离线'
        : !this.grant.desktop && /^(cua(?:_|$)|computer[_-]?use|desktop[_-])/iu.test(execution.name) ? '本机未授权桌面操作' : undefined)
    })
    ctx.on('tools/pre-execute', async (execution, next) => {
      await waitOnline(execution.signal)
      const args = fields(execution.arguments)
      const isShell = ['bash', 'powershell', 'pwsh'].includes(execution.name)
      if ('sandbox_permissions' in args || args.run_in_background === true || args.detached === true) {
        return { kind: 'deny', reason: '业务会话不能扩大本机权限或启动后台命令' }
      }
      if (execution.name === 'working_directory' && args.cd !== undefined) {
        return { kind: 'deny', reason: '请在本机重新选择工作区' }
      }
      if (!await this.toolPath(this.grant.workspace)) return { kind: 'deny', reason: '本机工作区已变更' }
      if (isShell || fileTools.has(execution.name)) {
        const readUpload = execution.name === 'read' || execution.name === 'read_image'
        for (const target of [args.file_path, args.path, args.cwd, args.workdir, args.directory]) {
          if (typeof target === 'string' && !await this.toolPath(target, readUpload)) {
            return { kind: 'deny', reason: '路径超出本机授权范围' }
          }
        }
      }
      if (execution.name === 'present' && Array.isArray(args.files)) {
        for (const file of args.files) {
          if (typeof fields(file).path !== 'string' || !await this.toolPath(fields(file).path as string)) {
            return { kind: 'deny', reason: '产物须位于已授权的工作区' }
          }
        }
      }
      if (isShell) {
        const detail = JSON.stringify(args)
        if (!execution.agent || detail.length > 12_000) return { kind: 'deny', reason: '终端命令无法确认' }
        const allow = '仅允许此次'
        const answer = await this.ask(execution.agent, [{ id: 'shell', question: '允许运行此终端命令？', detail,
          options: [allow, '拒绝'], custom: false }], execution.signal)
        if (answer.answers[0]?.selected[0] !== allow) return { kind: 'deny', reason: '用户拒绝运行命令' }
      }
      await waitOnline(execution.signal)
      return next()
    }, { global: true, prepend: true })
    ctx.on('session/event', (session, event) => {
      if (session.id !== this.id) return
      if (event.type === 'deliverables/presented') {
        for (const { path } of event.data.files) {
          const target = resolve(this.grant.workspace, path)
          if (!within(this.grant.workspace, target) || this.outputs.size >= 96) continue
          const id = createHash('sha256').update(target).digest('hex')
          this.outputs.set(id, { id, name: basename(target), path: relative(this.grant.workspace, target) })
        }
      }
      this.changed()
    }, { global: true })
    ctx.on('agent/status', ({ agent }) => { if (agent.session.id === this.id) this.changed() }, { global: true })
    ctx.on('user-questions/request', async (request) => {
      if (!request.agent) throw new Error('业务会话无法核对问题来源')
      const items = request.questions.map(item => ({ ...item,
        options: item.options?.filter(option => item.intent?.kind !== 'approval' || item.intent.always !== option.label).map(option => option.label),
        custom: item.intent?.kind !== 'approval' && item.intent?.kind !== 'plan-review',
      }))
      return this.ask(request.agent, items, request.signal)
    }, { global: true, prepend: true })
    const argumentsByCall = new Map<string, string>()
    ctx.on('tools/pre-execute', async (execution, next) => {
      argumentsByCall.set(execution.callId, JSON.stringify(execution.arguments).slice(0, 12_000))
      try { return await next() } finally { argumentsByCall.delete(execution.callId) }
    }, { global: true, prepend: true })
    ctx.on('approval/request', async (request) => {
      const detail = [request.reason, request.callId && argumentsByCall.get(request.callId)].filter(Boolean).join('\n')
      const accepted = '仅允许此次'
      try {
        const answer = await this.ask(request.agent, [{ id: 'approval', question: `允许执行 ${request.toolName}？`,
          detail, options: [accepted, '拒绝'], custom: false }], request.signal)
        return (answer.answers[0]?.selected[0] === accepted ? 'allowed-once' : 'rejected') satisfies ApprovalOutcome
      } catch {
        return 'cancelled'
      }
    }, { global: true, prepend: true })
  }

  /**
   * 为已配对的工作区限定上传目录、会话身份和可调用的远程操作。
   * @param ctx - 已装配对话服务及远程访问控制的上下文。
   */
  async start(ctx: Context): Promise<void> {
    this.ctx = ctx
    this.uploadDirectory = await privateDirectory(this.grant.root, 'uploads')
    this.peer = ctx.connection.createPeer({ principal: { kind: 'business-assistant', launch: this.grant.launch }, interactions: 'none' })
    ctx.remoteAccess.registerPolicy('business-assistant', {
      bindings: (principal): RemoteAccessBinding[] => {
        if (principal.launch !== this.grant.launch || !this.grant.online()) return []
        return [
          { role: { name: 'business-assistant:start', resource: 'session', actions: ['session/create'] },
            resource: { kind: 'session', id: this.id },
            condition: ({ args }: { args?: Readonly<Record<string, unknown>> }): RemoteAccessDecision => {
              const request = fields(args?.request)
              return !this.admitted && request.cwd === this.grant.workspace && request.sessionId === this.id && !request.workspaceId
                ? { kind: 'allow' } : { kind: 'deny', reason: 'workspace' }
            } },
          { role: { name: 'business-assistant:session', resource: 'session', actions: ['session/events', 'session/prompt', 'session/cancel'] },
            resource: { kind: 'session', id: this.id } },
        ]
      },
    })
  }

  private requireConnected(): void {
    if (!this.grant.online() || this.disposed) throw new Error('业务连接已离线')
  }

  private async toolPath(input: string, allowUpload = false): Promise<boolean> {
    const target = resolve(this.grant.workspace, input)
    for (const root of [this.grant.workspace, allowUpload ? this.uploadDirectory : undefined]) {
      if (root === undefined || !within(root, target)) continue
      let ancestor = target
      while (within(root, ancestor)) {
        try {
          const current = await lstat(ancestor)
          return (current.isDirectory() || current.isFile() && current.nlink === 1)
            && await realpath(ancestor) === ancestor
        }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') return false
          const parent = resolve(ancestor, '..')
          if (parent === ancestor) return false
          ancestor = parent
        }
      }
    }
    return false
  }

  private invoke<T>(method: string, request: object): Promise<T> {
    const ctx = this.ctx
    const peer = this.peer
    if (!ctx || !peer) throw new Error('本机会话尚未就绪')
    return ctx.typertGateway.invoke({ namespace: 'session', method, args: { request }, peer, signal: this.grant.signal }) as Promise<T>
  }

  private async setup(): Promise<void> {
    this.requireConnected()
    const current = await this.invoke<{ sessionId: string }>('create', { cwd: this.grant.workspace, sessionId: this.id })
    if (current.sessionId !== this.id) throw new Error('本机会话归属不符')
    this.admitted = true
  }

  private busy(): boolean {
    return this.activePrompt || this.ctx?.get('agents')?.get(this.id)?.status === 'running'
  }

  private changed(): void {
    if (this.timer !== undefined || this.disposed || !this.grant.online()) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.publish().catch(() => {})
    }, 150)
  }

  private async publish(): Promise<void> {
    this.requireConnected()
    const revision = ++this.snapshotRevision
    const history = this.admitted ? await this.invoke<SessionEventsPage>('events', {
      address: { kind: 'session', sessionId: this.id }, maxMessages: 40,
    }) : undefined
    if (revision <= this.publishedRevision) return
    this.publishedRevision = revision
    const messages = (history?.records ?? []).flatMap(({ event }) => {
      if (event.type !== 'assistant/message' && event.type !== 'user/message') return []
      if (event.type === 'user/message') {
        const source = fields(fields(event.data).source)
        const principal = fields(source.principal)
        if (source.kind !== 'user' || principal.kind !== 'business-assistant' || principal.launch !== this.grant.launch) return []
      }
      const text = visibleText(event.data).split('\n\n[本次附件]\n')[0]?.slice(0, 8000)
      return text ? [{ seq: event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text }] : []
    })
    this.grant.emit({ messages, seq: history?.cursor ?? 0, busy: this.busy(),
      activity: this.busy() ? '正在处理' : undefined,
      plugins: this.plugins.list(),
      files: [...this.files.values(), ...this.outputs.values()].map(file => ({ id: file.id, name: file.name })),
      question: this.questions.values().next().value?.screen,
      remote: this.remote.summary() })
  }

  private ask(agent: Agent, items: Item[], signal?: AbortSignal): Promise<AskUserQuestionAnswer> {
    this.requireConnected()
    if (agent.session.id !== this.id) throw new Error('问题不属于当前会话')
    const id = randomUUID()
    const digest = createHash('sha256').update(JSON.stringify([this.grant.launch, agent.session.id, id, items])).digest('hex')
    const scope = signal === undefined ? this.grant.signal : AbortSignal.any([this.grant.signal, signal])
    scope.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = (): void => { settle(); reject(new Error('业务问题已取消', { cause: scope.reason })) }
      const settle = (): void => {
        scope.removeEventListener('abort', abort)
        this.questions.delete(id)
        this.changed()
      }
      scope.addEventListener('abort', abort, { once: true })
      this.questions.set(id, { screen: { id, digest, items }, resolve: (answer) => { settle(); resolve(answer) } })
      this.changed()
    })
  }

  private answer(frame: Record<string, unknown>): void {
    const question = this.questions.get(boundedText(frame.question, 37))
    if (!question || question.screen.digest !== frame.digest) throw new Error('该问题已处理或已失效')
    const items = question.screen.items
    if (!Array.isArray(frame.answers) || frame.answers.length !== items.length) throw new Error('请完成所有答复')
    const replies = frame.answers as unknown[]
    const answers: AskUserQuestionAnswerItem[] = items.map((item) => {
      const reply = fields(replies.find(candidate => fields(candidate).id === item.id))
      const selected: unknown[] = Array.isArray(reply.selected) ? reply.selected : []
      const custom = boundedText(reply.custom, 2000).trim()
      if ((!item.multiSelect && selected.length > 1) || selected.some(value => typeof value !== 'string' || !item.options?.includes(value))
        || (!item.custom && custom) || (selected.length === 0 && !custom)) throw new Error('答复与当前问题不匹配')
      return { id: item.id, selected: [...new Set(selected as string[])], ...(custom ? { custom } : {}) }
    })
    question.resolve({ answers })
  }

  private async upload(id: string, frame: Record<string, unknown>): Promise<void> {
    const name = boundedText(frame.name, 160).trim()
    if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f:]/u.test(name)) throw new Error('文件名无效')
    const data = frame.data
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
      throw new Error('附件无效或超过 2 MB')
    }
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > MAX_FILE || bytes.toString('base64') !== data) throw new Error('附件无效或超过 2 MB')
    const uploads = this.uploadDirectory
    if (!uploads || this.files.size >= 24) throw new Error('附件已达到本次会话的上限')
    const path = join(uploads, `${id}-${name}`)
    this.files.set(id, { id, name, path, attached: false })
    try {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    } catch {
      this.files.delete(id)
      throw new Error('附件保存失败')
    }
    this.changed()
  }

  private async download(frame: Record<string, unknown>): Promise<object> {
    try {
      if (typeof frame.artifact === 'string') {
        const file = this.files.get(frame.artifact)
        if (file && this.uploadDirectory) {
          const bytes = await readScopedFile(this.uploadDirectory, basename(file.path))
          return { name: file.name, data: bytes.toString('base64') }
        }
        const artifact = this.outputs.get(frame.artifact)
        if (artifact) {
          const bytes = await readScopedFile(this.grant.workspace, artifact.path)
          return { name: artifact.name, data: bytes.toString('base64') }
        }
        throw new Error('附件不存在')
      }
      const path = boundedText(frame.path, 1024)
      const bytes = await readScopedFile(this.grant.workspace, path)
      return { name: basename(path), data: bytes.toString('base64') }
    } catch (failure) {
      if (failure instanceof Error && !('code' in failure)) throw failure
      throw new Error('无法读取所选文件')
    }
  }

  private async prompt(id: string, frame: Record<string, unknown>): Promise<void> {
    const text = boundedText(frame.text, 16_000).trim()
    if (!text || this.busy()) throw new Error('请等待当前对话完成')
    this.activePrompt = true
    try {
      await (this.running ??= this.setup().catch((failure: unknown) => { this.running = undefined; throw failure }))
      if (await realpath(this.grant.workspace) !== this.grant.workspace || !(await lstat(this.grant.workspace)).isDirectory()) {
        throw new Error('本机工作区已变更')
      }
      this.requireConnected()
      const files = [...this.files.values()].filter(file => !file.attached)
      const prompt = files.length === 0 ? text : text + '\n\n[本次附件]\n' +
        files.map(file => JSON.stringify({ 名称: file.name, 路径: file.path })).join('\n')
      await this.invoke('prompt', { sessionId: this.id, requestId: id, mode: 'queue', content: [{ type: 'text', text: prompt }] })
      files.forEach((file) => { file.attached = true })
    } catch (failure) {
      if (failure instanceof Error && 'code' in failure && typeof failure.code === 'string' && /model/iu.test(failure.code)) {
        throw new Error('此设备的业务模型不可用，请联系管理员')
      }
      if (failure instanceof Error && !('code' in failure)) throw failure
      if (failure instanceof Error && 'code' in failure && typeof failure.code === 'string') {
        this.ctx?.get('logger')?.warn('业务会话请求失败，类型=%s', failure.code)
      }
      throw new Error('本机会话未能受理消息，请核对本机模型及工作区')
    } finally {
      this.activePrompt = false
      this.changed()
    }
  }

  async request(operation: string, id: string, frame: Record<string, unknown>): Promise<unknown> {
    this.requireConnected()
    switch (operation) {
      case 'sync':
        await this.publish()
        return this.plugins.list()
      case 'plugin': return this.plugins.load(boundedText(frame.plugin, 121), boundedText(frame.revision, 65))
      case 'prompt': return this.prompt(id, frame)
      case 'cancel':
        try {
          if (this.remote.current?.cancellable()) await this.remote.current.act('remote-cancel', id, frame)
        } finally {
          if (this.admitted) await this.invoke('cancel', { sessionId: this.id })
        }
        return
      case 'answer': this.answer(frame); return
      case 'upload':
        if (this.busy()) throw new Error('请等待当前对话完成')
        return this.upload(id, frame)
      case 'download': return this.download(frame)
      case 'remote-cancel':
      case 'remote-resume':
        if (!this.remote.current?.run || frame.run !== this.remote.current.run.run_id) throw new Error('当前智能体运行已变化')
        return this.remote.current.act(operation, id, frame)
      case 'remote-verify': return this.remote.verify(frame.admission)
      default: throw new Error('业务助手不支持此操作')
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.ctx?.get('agents')?.get(this.id)?.cancel({ kind: 'user' })
    await this.peer?.dispose()
  }
}
