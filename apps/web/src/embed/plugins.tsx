import { useEffect, useRef, useState } from 'react'
import { Alert, Modal, Spin } from 'antd'
import { fields } from './protocol.ts'
import type { EmbedPlugin } from './protocol.ts'

/** 插件只能从专用端口读取当前会话的有限状态。 */
export function PluginPanel({ plugin, call, busy, close }: {
  plugin: EmbedPlugin
  call: (op: string, payload: Record<string, unknown>) => Promise<unknown>
  busy: boolean
  close: () => void
}) {
  const [source, setSource] = useState<string>()
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const port = useRef<MessagePort>()
  const timeout = useRef<number>()
  const busyRef = useRef(busy)
  const callRef = useRef(call)
  busyRef.current = busy
  callRef.current = call

  useEffect(() => {
    let live = true
    const isLive = () => live
    void (async () => {
      try {
        const resource = await callRef.current('plugin', { plugin: plugin.id, revision: plugin.revision })
        const code = fields(resource).source
        if (typeof code !== 'string') throw new Error('会话插件资源无效')
        const bytes = new TextEncoder().encode(code)
        if (!bytes.length || bytes.length > 256 * 1024) throw new Error('会话插件资源无效')
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
        if (Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('') !== plugin.revision) {
          throw new Error('会话插件版本已变更')
        }
        if (isLive()) setSource(code)
      } catch (failure) {
        if (isLive()) setError(failure instanceof Error ? failure.message : '无法加载会话插件')
      }
    })()
    timeout.current = window.setTimeout(() => { setError(previous => previous || '会话插件未能启动') }, 15_000)
    return () => {
      live = false
      window.clearTimeout(timeout.current)
      port.current?.close()
    }
  }, [plugin])

  return <Modal open title={plugin.name} footer={null} onCancel={close}>
    {!loaded && !error && <Spin />}
    {!loaded && error && <Alert type="error" showIcon title={error} />}
    {source && (loaded || !error) && <iframe className="embed-plugin" title={plugin.name} sandbox="allow-scripts"
      referrerPolicy="no-referrer" src="/embed-plugin.html" onLoad={(event) => {
        if (port.current) {
          port.current.close()
          setLoaded(false)
          setError('会话插件连接已结束')
          return
        }
        const child = event.currentTarget.contentWindow
        if (!child) return
        const channel = new MessageChannel()
        port.current = channel.port1
        channel.port1.onmessage = (message: MessageEvent<unknown>) => {
          const { type, op, id } = fields(message.data)
          if (type === 'ready') { window.clearTimeout(timeout.current); setLoaded(true); return }
          if (type === 'failed') { setLoaded(false); setError('会话插件运行失败'); return }
          if (type !== 'rpc' || op !== 'session.status' || typeof id !== 'number' || !Number.isSafeInteger(id)) return
          channel.port1.postMessage({ type: 'result', id, data: { connected: true, busy: busyRef.current } })
        }
        // 子帧使用不透明来源。发给该窗口的只有校验后的模块源码和专用端口。
        child.postMessage({ type: 'harness:plugin', source }, '*', [channel.port2])
      }} />}
  </Modal>
}
