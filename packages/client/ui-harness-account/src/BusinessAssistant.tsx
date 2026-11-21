import React, { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Form, Input, Modal, Space, Typography } from 'antd'
import { copy, type AuthTransport } from './shared.ts'

type Pair = { id: string; tenant: string; account: string; entry: 'pc' | 'web' | 'standalone'; nativePicker: boolean }
type Status = { state: 'idle' | 'confirm' | 'connecting' | 'active' | 'closed'; error?: string; workspace?: string }

async function embed<T>(transport: AuthTransport | undefined, operation: 'status' | 'lookup' | 'pick' | 'claim' | 'disconnect', body?: object): Promise<T> {
  if (transport) return transport.request<T>(`pairing/${operation}`, body)
  const bridge = (window as Window & { agentAssistantAccount?: { request(operation: string, data?: object): Promise<
    { ok: true; value: T } | { ok: false; error: { message: string } }> } }).agentAssistantAccount
  if (bridge) {
    const result = await bridge.request(`pairing/${operation}`, body)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const response = await fetch(`/api/harness-embed/${operation}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    credentials: 'same-origin', cache: 'no-store',
  })
  const data = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(data.error || copy.unavailable)
  return data
}

/** 本机配对表单使用由入口提供的同源接口或桌面 IPC。 */
export function BusinessAssistant({ compact, transport }: { compact: boolean; transport?: AuthTransport }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [chat, setChat] = useState(false)
  const [code, setCode] = useState('')
  const [pair, setPair] = useState<Pair>()
  const [status, setStatus] = useState<Status>()
  const [workspace, setWorkspace] = useState('')
  const [desktop, setDesktop] = useState(false)
  const [agents, setAgents] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const connected = status && ['confirm', 'connecting', 'active'].includes(status.state)

  useEffect(() => {
    if (!open) return
    let live = true
    const sync = async (): Promise<void> => {
      try {
        const state = await embed<Status>(transport, 'status')
        if (live) setStatus(state)
      } catch { if (live) setError(copy.unavailable) }
    }
    void sync()
    const timer = window.setInterval(() => { void sync() }, 2500)
    return () => { live = false; window.clearInterval(timer) }
  }, [open, revision, transport])

  const perform = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await run() }
    catch (failure) { setError(failure instanceof Error ? failure.message : copy.unavailable) }
    finally { setBusy(false) }
  }
  const close = (): void => {
    setOpen(false); setPair(undefined); setCode(''); setError(''); setWorkspace(''); setDesktop(false); setAgents(false)
  }

  return <>
    <Button type="text" size={compact ? 'small' : 'middle'} title={copy.businessAssistant}
      onClick={() => { setOpen(true) }}>{compact ? copy.businessShort : copy.businessAssistant}</Button>
    <Modal open={open} title={copy.businessAssistant} onCancel={() => { if (!busy) close() }} footer={null} destroyOnHidden>
      {(error || status?.error) && <Alert type="error" title={error || status?.error} showIcon />}
      {connected ? <Space orientation="vertical">
        <Typography.Text>{status.state === 'confirm' ? copy.businessWaitConfirm : status.state === 'active' ? copy.businessConnected : copy.businessConnecting}</Typography.Text>
        {status.workspace && <Typography.Text>{copy.businessWorkspace}　{status.workspace}</Typography.Text>}
        {!transport && <Button type="primary" disabled={status.state !== 'active'} onClick={() => {
          setOpen(false)
          setChat(true)
        }}>{copy.businessChat}</Button>}
        <Button danger loading={busy} onClick={() => { void perform(async () => {
          await embed(transport, 'disconnect', {})
          setStatus({ state: 'closed' })
          setRevision(value => value + 1)
        }) }}>{copy.businessDisconnect}</Button>
      </Space> : pair ? <Form key="grant" layout="vertical" onFinish={() => { void perform(async () => {
        await embed(transport, 'claim', { id: pair.id, workspace, desktop, agents })
        setPair(undefined); setCode(''); setStatus({ state: 'confirm', workspace })
        setRevision(value => value + 1)
      }) }}>
        <Space orientation="vertical">
          <Typography.Text strong>{pair.tenant} · {pair.account}</Typography.Text>
          <Typography.Text type="secondary">{pair.entry === 'pc' ? copy.businessPc : pair.entry === 'web' ? copy.businessWeb : copy.businessLocal}</Typography.Text>
        </Space>
        <Form.Item label={copy.businessWorkspace} required>
          <Space.Compact block>
            <Input aria-label={copy.businessWorkspace} value={workspace} maxLength={1024}
              onChange={(event) => { setWorkspace(event.target.value) }} placeholder={copy.businessWorkspacePath} />
            {pair.nativePicker && <Button disabled={busy} onClick={() => { void perform(async () => {
              const result = await embed<{ workspace: string | null }>(transport, 'pick', { id: pair.id })
              if (result.workspace) setWorkspace(result.workspace)
            }) }}>{copy.businessBrowse}</Button>}
          </Space.Compact>
        </Form.Item>
        <Form.Item><Space orientation="vertical">
          <Typography.Text type="secondary">{copy.businessLocalFiles}</Typography.Text>
          <Checkbox checked={desktop} onChange={(event) => { setDesktop(event.target.checked) }}>{copy.businessDesktop}</Checkbox>
          <Checkbox checked={agents} onChange={(event) => { setAgents(event.target.checked) }}>{copy.businessAgents}</Checkbox>
        </Space></Form.Item>
        <Space>
          <Button onClick={() => { setPair(undefined); setCode('') }} disabled={busy}>{copy.cancel}</Button>
          <Button type="primary" htmlType="submit" aria-label={copy.businessGrant}
            loading={busy} disabled={!workspace.trim()}>{copy.businessGrant}</Button>
        </Space>
      </Form> : <Form key="lookup" layout="vertical" onFinish={() => { void perform(async () => {
        const result = await embed<Pair>(transport, 'lookup', { code: code.trim() })
        setWorkspace(''); setDesktop(false); setAgents(false)
        setPair(result)
      }) }}>
        <Form.Item label={copy.businessCode}>
          <Input aria-label={copy.businessCode} autoComplete="off" value={code} maxLength={8}
            onChange={(event) => { setCode(event.target.value.toUpperCase()) }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" loading={busy} disabled={!/^[0-9A-F]{8}$/u.test(code)}>{copy.businessLookup}</Button>
      </Form>}
    </Modal>
    <Modal open={chat} title={copy.businessChat} onCancel={() => { setChat(false) }} footer={null} destroyOnHidden width={960}>
      <iframe title={copy.businessChat} src="/embed.html" style={{ display: 'block', border: 0, width: '100%', height: 'min(68vh, 680px)' }} />
    </Modal>
  </>
}
