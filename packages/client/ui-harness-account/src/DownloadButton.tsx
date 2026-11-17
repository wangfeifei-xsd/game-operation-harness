/** 手选安装目标；只展示服务端已验证的索引，不根据浏览器猜造链接。 */
import React, { useEffect, useRef, useState } from 'react'
import { Alert, Button, Modal, Select, Space, Spin, Typography } from 'antd'
import { IconDownloadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { copy, type AuthTransport } from './shared.ts'

interface DownloadFile { target: string; url: string; filename: string; bytes: number; sha256: string }
interface DownloadIndex { version: string; files: DownloadFile[] }

/**
 * Web 和 PWA 的安装包入口；Electron 不注册此组件。
 * @param props - 公开下载传输及紧凑显示选择。
 * @returns 下载按钮与目标选择弹窗。
 */
export function DownloadButton({ transport, compact = false }: { transport: AuthTransport; compact?: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [index, setIndex] = useState<DownloadIndex | null>(null)
  const [target, setTarget] = useState('macos-arm64')
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => { request.current?.abort() }, [])
  const close = (): void => { request.current?.abort(); setOpen(false) }
  const load = async (): Promise<void> => {
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setLoading(true); setFailed(false)
    try {
      const value = await transport.request<DownloadIndex | null>('downloads', undefined, controller.signal)
      if (!controller.signal.aborted) setIndex(value)
    } catch (_unavailable) { if (!controller.signal.aborted) { setIndex(null); setFailed(true) } }
    finally { if (!controller.signal.aborted) setLoading(false) }
  }
  const file = index?.files.find(value => value.target === target)
  return <>
    <Button className="harness-download" type="text" title={copy.download} aria-label={copy.download} block={compact}
      icon={<IconDownloadOutlineRegular size={20} />}
      onClick={() => { setOpen(true); void load() }}>{compact ? null : copy.download}</Button>
    <Modal title={copy.downloadTitle} open={open} onCancel={close} footer={null} destroyOnHidden>
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        <Select aria-label={copy.target} value={target} onChange={setTarget} style={{ width: '100%' }} options={[
          { value: 'macos-arm64', label: copy.macArm }, { value: 'macos-x64', label: copy.macIntel }, { value: 'windows-x64', label: copy.winX64 },
        ]} />
        {loading ? <Spin /> : failed ? <Alert type="error" title={copy.downloadFailed} action={<Button onClick={() => void load()}>{copy.retry}</Button>} />
          : file === undefined ? <Alert type="info" title={copy.unpublished} /> : <>
            <Typography.Text>{index?.version}</Typography.Text>
            <Typography.Text>{file.filename}</Typography.Text>
            <Typography.Text>{copy.fileSize}: {(file.bytes / 1048576).toFixed(1)} MB</Typography.Text>
            <Typography.Paragraph copyable={{ text: file.sha256 }} style={{ overflowWrap: 'anywhere' }}>{copy.checksum}: {file.sha256}</Typography.Paragraph>
            <Button type="primary" href={file.url} rel="noreferrer" target="_blank">{copy.downloadFile}</Button>
          </>}
      </Space>
    </Modal>
  </>
}
