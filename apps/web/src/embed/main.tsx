import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Button, Card, Collapse, ConfigProvider, Empty, Form, Input, Modal, Select, Space, Spin, Tag, Typography, theme } from 'antd'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { API, PROTOCOL, api, fields, messageText, openStartup, pageChallenge, receiptsSchema, relayFrame, snapshotSchema } from './protocol.ts'
import type { EmbedPlugin, Receipts, Snapshot, Startup, Status } from './protocol.ts'
import { BusinessAccess } from './BusinessAccess.tsx'
import { PluginPanel } from './plugins.tsx'
import './style.css'

type Access = { id: string; credential: string }
const operationLabels = { prompt: '发送消息', cancel: '停止对话', answer: '提交答复', upload: '添加文件',
  'remote-resume': '继续智能体运行', 'remote-cancel': '取消智能体运行', 'remote-verify': '核查智能体运行' } satisfies
  Record<Receipts['entries'][number]['op'], string>
type Pending = { frame: Record<string, unknown>; timer: number; resolve: (value: unknown) => void; reject: (error: Error) => void }
const blank: Snapshot = { messages: [], busy: false }
const emptyReceipts: Receipts = { revision: -1, entries: [] }
function isLocalView(): boolean {
  if (location.pathname !== '/embed.html' || window.parent === window) return false
  const loopback = location.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)
  if (!loopback && !(location.protocol === 'dsh-app:' && location.hostname === 'app')) return false
  try { return window.parent.location.href.startsWith(`${location.protocol}//${location.host}/`) }
  catch (_crossOrigin) { return false }
}
const local = isLocalView()
const ownerChat = '/api/harness-embed/chat'

async function localChat<T>(signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(ownerChat, {
    signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const data: unknown = await response.json()
  if (!response.ok) throw new Error(messageText(fields(data).error, '本机业务会话不可用'))
  return data as T
}

function clearRequests(requests: Map<string, Pending>, message: string): void {
  for (const item of requests.values()) {
    window.clearTimeout(item.timer)
    item.reject(new Error(message))
  }
  requests.clear()
}

function bytesFromFile(file: File): Promise<string> {
  return file.arrayBuffer().then((result) => {
    let data = ''
    const bytes = new Uint8Array(result)
    for (let offset = 0; offset < bytes.length; offset += 8_192) data += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
    return btoa(data)
  })
}

function Assistant() {
  const start = useRef<Startup>()
  const startupRequest = useRef<AbortController>()
  const localLaunch = useRef<string>()
  const localLifetime = useRef<AbortSignal>()
  const socket = useRef<WebSocket>()
  const requests = useRef(new Map<string, Pending>())
  const [access, setAccess] = useState<Access>()
  const [status, setStatus] = useState<Status>()
  const [loading, setLoading] = useState(true)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot>(blank)
  const [receipts, setReceipts] = useState<Receipts>(emptyReceipts)
  const [plugin, setPlugin] = useState<EmbedPlugin>()
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [download, setDownload] = useState(false)
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const bottom = useRef<HTMLDivElement>(null)
  const upload = useRef<HTMLInputElement>(null)
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom?: string }>>({})
  const [downloadForm] = Form.useForm<{ path: string }>()

  const launch = useCallback(async (reset = false) => {
    const startup = start.current
    if (!startup) return
    startupRequest.current?.abort()
    const pending = new AbortController()
    startupRequest.current = pending
    clearRequests(requests.current, '助手会话已结束')
    setError(''); setStatus(undefined); setAccess(undefined); setSnapshot(blank); setLoading(true); setConnected(false)
    setReceipts(emptyReceipts); setPlugin(undefined)
    try {
      const { challenge, verifier } = await pageChallenge()
      const { launchId, ticket } = await startup.request(challenge, reset)
      if (pending.signal.aborted) return
      const result = await api<{ credential: string }>(`/launches/${launchId}/exchange`, undefined, { ticket, verifier }, pending.signal)
      if (start.current === startup && !pending.signal.aborted) {
        setAccess({ id: launchId, credential: result.credential })
        startup.authenticated(launchId)
      }
    } catch (failure) {
      if (start.current === startup && !pending.signal.aborted) {
        setError(failure instanceof Error ? failure.message : '无法启动助手')
        startup.failed()
      }
    } finally { if (start.current === startup && !pending.signal.aborted) setLoading(false) }
  }, [])

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (): void => { setDark(media.matches) }
    media.addEventListener('change', update)
    if (!local) try {
      start.current = openStartup(() => {
        setAccess(undefined); setStatus(undefined); setConnected(false)
        setReceipts(emptyReceipts); setPlugin(undefined)
        setSnapshot(blank); setError('业务连接已结束，请重新打开助手')
      })
      void launch()
    } catch (failure) { setError((failure as Error).message); setLoading(false) }
    const pending = requests.current
    return () => {
      startupRequest.current?.abort()
      start.current?.dispose()
      start.current = undefined
      media.removeEventListener('change', update)
      clearRequests(pending, '助手已关闭')
    }
  }, [launch])

  useEffect(() => {
    if (!local) return
    const lifetime = new AbortController()
    localLifetime.current = lifetime.signal
    let timer = 0
    let unavailable = false
    const poll = async (): Promise<void> => {
      try {
        const view = await localChat<{
          launch?: string
          online: boolean
          status?: Status
          snapshot?: Snapshot
          receipts?: Receipts
        }>(lifetime.signal)
        if (lifetime.signal.aborted) return
        if (localLaunch.current && view.launch !== localLaunch.current) {
          setConnected(false); setStatus(undefined); setSnapshot(blank); setReceipts(emptyReceipts)
          setError('业务会话已结束，请重新打开')
          return
        }
        localLaunch.current = view.launch
        setConnected(view.online)
        if (view.status) setStatus(view.status)
        if (view.snapshot) setSnapshot(view.snapshot)
        if (view.receipts) setReceipts(view.receipts)
        if (!view.online) {
          setPlugin(undefined)
          setError('正在等待业务端确认或恢复连接')
          unavailable = true
        } else if (unavailable) {
          setError('')
          unavailable = false
        }
      } catch (failure) {
        if (lifetime.signal.aborted) return
        setConnected(false); setPlugin(undefined)
        setError(failure instanceof Error ? failure.message : '本机业务会话不可用')
        unavailable = true
      } finally {
        if (!lifetime.signal.aborted) setLoading(false)
      }
      timer = window.setTimeout(() => { void poll() }, 1000)
    }
    void poll()
    return () => { lifetime.abort(); window.clearTimeout(timer) }
  }, [])

  useEffect(() => {
    if (!access) return
    const abort = new AbortController()
    let timer = 0
    const poll = async (): Promise<void> => {
      try {
        const current = await api<Status>(`/launches/${access.id}`, access.credential, undefined, abort.signal)
        if (abort.signal.aborted) return
        setStatus(current)
        if (current.protocol !== PROTOCOL) { setError('请更新本机 Agent 助手'); return }
        if (current.state === 'active') return
      } catch (failure) {
        if (abort.signal.aborted) return
        setError((failure as Error).message)
        return
      }
      timer = window.setTimeout(() => { void poll() }, 1800)
    }
    void poll()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [access, confirming])

  useEffect(() => {
    if (!access || status?.state !== 'active' || status.protocol !== PROTOCOL) return
    let disposed = false
    let renewal = 0
    let retry = 0
    let current: WebSocket | undefined
    const pending = requests.current
    const connect = (): void => {
      const url = new URL(API + '/relay', location.href)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(url)
      let online = false
      let sync: string | undefined
      let synced = false
      current = ws
      socket.current = ws
      const send = (frame: unknown): void => { ws.send(JSON.stringify(frame)) }
      const ping = (): void => { send({ type: 'ping' }) }
      const updateReceipts = (value: unknown): void => {
        const parsed = receiptsSchema.safeParse(value)
        if (parsed.success) setReceipts(previous => parsed.data.revision > previous.revision ? parsed.data : previous)
      }
      ws.onopen = () => {
        send({ type: 'authenticate', role: 'page', protocol: PROTOCOL, launch_id: access.id, credential: access.credential })
      }
      ws.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (disposed || current !== ws) return
        const frame = relayFrame(data)
        if (frame.type === 'ready') {
          ping()
          renewal = window.setInterval(ping, 4_000)
        } else if (frame.type === 'pong') {
          online = frame.online === true
          if (!online) {
            synced = false
            sync = undefined
            setConnected(false)
            return
          }
          if (!synced) {
            sync ??= randomUUID()
            send({ type: 'request', id: sync, op: 'sync' })
          }
          for (const item of pending.values()) send(item.frame)
        } else if (frame.type === 'event' && frame.kind === 'snapshot') {
          const parsed = snapshotSchema.safeParse(frame.snapshot)
          if (parsed.success) setSnapshot(parsed.data)
        } else if (frame.type === 'event' && frame.kind === 'receipts') {
          updateReceipts(frame.receipts)
        } else if (frame.type === 'reply' && typeof frame.id === 'string') {
          if (frame.id === sync) {
            if (frame.ok === true && online) {
              synced = true
              sync = undefined
              setConnected(true)
              setError('')
              updateReceipts(fields(frame.data).receipts)
            } else if (frame.ok === false) setError(messageText(frame.error, '无法读取本机会话'))
            return
          }
          const request = pending.get(frame.id)
          if (!request) return
          pending.delete(frame.id)
          window.clearTimeout(request.timer)
          if (frame.ok === true) request.resolve(frame.data)
          else request.reject(new Error(messageText(frame.error, '本机操作未完成')))
        }
      }
      ws.onclose = (event) => {
        clearInterval(renewal)
        if (socket.current === ws) socket.current = undefined
        if (disposed) return
        setConnected(false)
        setPlugin(undefined)
        if (event.code === 4403 || event.code === 4406) {
          setError(event.code === 4406 ? '请更新本机 Agent 助手' : '连接已失效，请重新配对')
          clearRequests(pending, '业务会话连接已结束')
          return
        }
        retry = window.setTimeout(connect, 1800)
      }
    }
    connect()
    return () => { disposed = true; clearInterval(renewal); clearTimeout(retry); current?.close() }
  }, [access, status?.state, status?.protocol])

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [snapshot.messages.length, snapshot.messages.at(-1)?.seq])
  useEffect(() => { setAnswers({}) }, [snapshot.question?.id])
  const plugins = snapshot.plugins ?? []
  const selectedPlugin = plugin && plugins.some(item => item.id === plugin.id && item.revision === plugin.revision) ? plugin : undefined

  const call = (op: string, payload: Record<string, unknown> = {}): Promise<unknown> => {
    if (local) {
      const launch = localLaunch.current
      const lifetime = localLifetime.current
      if (!connected || !launch || !lifetime) return Promise.reject(new Error('本机尚未连接'))
      return localChat<{ data: unknown }>(AbortSignal.any([lifetime, AbortSignal.timeout(30_000)]),
        { launch, frame: { ...payload, type: 'request', id: randomUUID(), op } }).then(({ data }) => data)
    }
    return new Promise((resolve, reject) => {
      const ws = socket.current
      if (!connected || !ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('本机尚未连接')); return }
      if (requests.current.size >= 16) { reject(new Error('请等待当前操作完成')); return }
      const id = randomUUID()
      const frame = { ...payload, type: 'request', id, op }
      const timer = window.setTimeout(() => {
        if (requests.current.delete(id)) reject(new Error('未收到回执，请查看操作记录'))
      }, 30_000)
      requests.current.set(id, { frame, timer, resolve, reject })
      ws.send(JSON.stringify(frame))
    })
  }

  const sendPrompt = async (): Promise<void> => {
    if (!prompt.trim() || sending) return
    const submitted = prompt
    setSending(true); setError('')
    try { await call('prompt', { text: submitted }); setPrompt(value => value === submitted ? '' : value) }
    catch (failure) { setError((failure as Error).message) }
    finally { setSending(false) }
  }
  const collectFile = async (file: File): Promise<void> => {
    if (file.size > 2 * 1024 * 1024) { setError('文件不能超过 2 MB'); return }
    await call('upload', { name: file.name, data: await bytesFromFile(file) })
  }
  const downloadFile = async (path: string, id?: string): Promise<void> => {
    const result = await call('download', id ? { artifact: id } : { path }) as { name: string; data: string }
    const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    const link = document.createElement('a')
    link.href = url; link.download = result.name
    link.click()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
    setDownload(false)
  }
  const report = (failure: unknown): (void) => { setError(failure instanceof Error ? failure.message : '操作未完成') }
  const question = snapshot.question
  const remote = snapshot.remote
  const device = status?.device
  const isActive = status?.state === 'active'

  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm, token: { borderRadius: 8 } }}>
    <div className="embed-shell" data-theme={dark ? 'dark' : 'light'}>
      <header className="embed-bar">
        <Space wrap size={8}>
          <Typography.Text strong>Agent 助手</Typography.Text>
          {status && <Typography.Text type="secondary">{status.tenant_name} · {status.business_name}</Typography.Text>}
          {device && isActive && <Tag color={connected ? 'green' : 'default'}>{connected ? '已连接' : '连接中'}</Tag>}
        </Space>
        {!local && <Button type="text" onClick={() => start.current?.close()}>关闭</Button>}
      </header>
      {error && <Alert className="embed-notice" type="error" showIcon title={error}
        action={!connected && !loading && start.current && <Button size="small" onClick={() => { void launch(true) }}>重新配对</Button>} />}
      {loading && <div className="embed-center"><Spin size="large" /></div>}
      {status?.state === 'waiting' && access && <div className="embed-center">
        <BusinessAccess pairCode={status.pair_code} />
      </div>}
      {status?.state === 'confirm' && device && <div className="embed-center"><Card title="核对本机连接">
        <Space orientation="vertical">
          <Typography.Text>设备　{device.name}</Typography.Text>
          <Typography.Text>工作区　{device.workspace}</Typography.Text>
          <Typography.Text>允许文件和终端{device.desktop ? '、桌面操作' : ''}</Typography.Text>
          {device.agents && <Typography.Text>允许调用 Creativity 智能体</Typography.Text>}
          <Space>
            <Button onClick={() => { void launch(true) }}>取消配对</Button>
            <Button type="primary" loading={confirming} onClick={() => {
              if (!access) return
              setConfirming(true)
              void api(`/launches/${access.id}/confirm`, access.credential, {}).catch(report).finally(() => { setConfirming(false) })
            }}>确认连接</Button>
          </Space>
        </Space>
      </Card></div>}
      {isActive && <div className="embed-chat">
        <div className="embed-device">
          <Typography.Text ellipsis title={device?.workspace ?? ''}>{device?.name} · {device?.workspace}</Typography.Text>
          <Space size={4} wrap>
            {plugins.length > 0 && <Select size="small" value={selectedPlugin?.id} aria-label="会话插件" placeholder="会话插件"
              disabled={!connected} options={plugins.map(item => ({ label: item.name, value: item.id }))}
              onChange={(id) => { setPlugin(plugins.find(item => item.id === id)) }} />}
            {!local && <Button size="small" type="text" onClick={() => {
              Modal.confirm({
                title: '解除该设备的关联？', okText: '解除', cancelText: '取消',
                onOk: () => start.current?.close(true),
              })
            }}>解除关联</Button>}
          </Space>
        </div>
        {!connected && <Alert title="正在连接已配对的本机助手" type="info" showIcon />}
        <div className="embed-messages" role="log">
          {snapshot.messages.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="开始对话" />}
          {snapshot.messages.map(message => <div key={message.seq} className={`embed-message embed-${message.role}`}>
            <Typography.Text type="secondary">{message.role === 'user' ? '我' : '助手'}</Typography.Text>
            <div>{message.text}</div>
          </div>)}
          <div ref={bottom} />
        </div>
        {snapshot.activity && <Typography.Text className="embed-activity" type="secondary">{snapshot.activity}</Typography.Text>}
        {receipts.entries.length > 0 && <Collapse className="embed-receipts" size="small" items={[{
          key: 'operations', label: '操作记录',
          children: <ul>{receipts.entries.slice().reverse().map(item => <li key={item.id}>
            {operationLabels[item.op]} · {item.state === 'pending' ? '已收到，处理中' : item.state === 'completed' ? '已受理' : item.error || '未完成'}
          </li>)}</ul>,
        }]} />}
        {remote && <Alert className="embed-notice" type="info" title={`${remote.name} · ${remote.state}`}
          description={<Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{remote.prompt}</Typography.Paragraph>}
          action={<Space wrap>
            {remote.admission && <Button size="small" disabled={!connected} onClick={() => {
              void call('remote-verify', { admission: remote.admission }).catch(report)
            }}>核查受理结果</Button>}
            {remote.cancellable && <Button size="small" disabled={!connected} onClick={() => {
              void call('remote-cancel', { run: remote.id }).catch(report)
            }}>取消运行</Button>}
            {remote.approve && <Button size="small" type="primary" disabled={!connected}
              onClick={() => {
                const { id, gate, prompt } = remote
                Modal.confirm({
                  title: '确认继续智能体运行？', content: prompt,
                  onOk: () => call('remote-resume', { run: id, gate, decision: 'approve' }).catch(report),
                })
              }}>继续</Button>}
            {remote.approve && <Button size="small" disabled={!connected}
              onClick={() => { void call('remote-resume', { run: remote.id, gate: remote.gate, decision: 'reject' }).catch(report) }}>拒绝</Button>}
            {remote.verify && <Button size="small" disabled={!connected}
              onClick={() => { void call('remote-resume', { run: remote.id, gate: remote.gate, decision: 'verify' }).catch(report) }}>核查</Button>}
            {remote.respond && <Button size="small" disabled={!connected} onClick={() => {
              const { id, gate } = remote
              let input = ''
              Modal.confirm({
                title: '补充智能体输入',
                content: <Input.TextArea placeholder="按输入约定填写 JSON 对象" onChange={(event) => { input = event.target.value }} />,
                onOk: () => call('remote-resume', { run: id, gate, decision: 'respond', text: input }).catch(report),
              })
            }}>补充</Button>}
          </Space>} />}
        {question && <Card size="small" className="embed-questions" title="需要你的答复">
          <Form component="div" layout="vertical">
            {question.items.map(item => <Form.Item key={item.id} label={item.question} extra={item.detail}>
              {item.options?.length ? <Select {...(item.multiSelect ? { mode: 'multiple' as const } : {})}
                options={item.options.map(label => ({ label, value: label }))}
                value={item.multiSelect ? answers[item.id]?.selected : answers[item.id]?.selected[0]}
                onChange={(value: string | string[] | undefined) => {
                  const selected = typeof value === 'string' ? [value] : value ?? []
                  setAnswers(previous => ({ ...previous, [item.id]: { ...previous[item.id], selected } }))
                }} />
                : <Input maxLength={2000} value={answers[item.id]?.custom}
                  onChange={(event) => {
                    setAnswers(previous => ({ ...previous, [item.id]: { selected: [], custom: event.target.value } }))
                  }} />}
              {item.options?.length && item.custom ? <Input maxLength={2000} placeholder="补充说明" value={answers[item.id]?.custom}
                onChange={(event) => {
                  setAnswers((previous) => {
                    const selected = previous[item.id]?.selected ?? []
                    return { ...previous, [item.id]: { selected, custom: event.target.value } }
                  })
                }} /> : null}
            </Form.Item>)}
            <Button type="primary" disabled={!connected} onClick={() => {
              const replies = question.items.map(item => ({
                id: item.id, selected: answers[item.id]?.selected ?? [], custom: answers[item.id]?.custom,
              }))
              void call('answer', { question: question.id, digest: question.digest, answers: replies }).catch(report)
            }}>提交答复</Button>
          </Form>
        </Card>}
        <Form component="div" className="embed-compose">
          {snapshot.files?.length ? <Space wrap>{snapshot.files.map(file => <Button key={file.id} disabled={!connected} size="small"
            onClick={() => { void downloadFile('', file.id).catch(report) }}>{file.name}</Button>)}</Space> : null}
          <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={16_000} value={prompt}
            onChange={(event) => { setPrompt(event.target.value) }}
            onPressEnter={(event) => {
              if ((event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing && connected && !snapshot.busy) {
                event.preventDefault()
                void sendPrompt()
              }
            }}
            placeholder="给助手发消息" aria-label="消息" />
          <input ref={upload} type="file" hidden onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void collectFile(file).catch(report)
          }} />
          <div className="embed-actions">
            <Space>
              <Button onClick={() => upload.current?.click()} disabled={!connected || snapshot.busy}>添加文件</Button>
              <Button onClick={() => { setDownload(true) }} disabled={!connected}>下载产物</Button>
            </Space>
            <Space>
              {snapshot.busy && <Button danger disabled={!connected} onClick={() => { void call('cancel').catch(report) }}>停止</Button>}
              <Button type="primary" disabled={!connected || !prompt.trim() || snapshot.busy} loading={sending}
                onClick={() => { void sendPrompt() }}>发送</Button>
            </Space>
          </div>
        </Form>
        <Modal open={download} title="下载工作区文件" onCancel={() => { setDownload(false) }} footer={null} destroyOnHidden>
          <Form component="div" form={downloadForm} onFinish={({ path }) => { void downloadFile(path).catch(report) }}>
            <Form.Item name="path" label="工作区相对路径" rules={[{ required: true, message: '请输入路径' }]}><Input maxLength={500} /></Form.Item>
            <Button type="primary" disabled={!connected} onClick={() => { downloadForm.submit() }}>下载</Button>
          </Form>
        </Modal>
        {connected && selectedPlugin && <PluginPanel key={selectedPlugin.revision} plugin={selectedPlugin} call={call} busy={snapshot.busy}
          close={() => { setPlugin(undefined) }} />}
      </div>}
    </div>
  </ConfigProvider>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Assistant />)
