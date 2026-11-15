/** 产品账号摘要与模型授权分开显示；导航和状态订阅由载体拥有。 */
import React, { useState } from 'react'
import { Alert, Button, ConfigProvider, Popconfirm, Space, Typography, theme } from 'antd'
import { DownloadButton } from './DownloadButton.tsx'
import { copy, errorText, type AuthTransport, type LocalSession } from './shared.ts'

/**
 * 侧栏底部的账号操作；窄栏以可访问名称保留操作。
 * @param props - 已筛选账号状态和载体拥有的退出操作。
 * @returns 账号、退出和可选下载入口。
 */
export function AccountControls({ session, wide, dark, transport, desktop, logout }: {
  session: LocalSession
  wide: boolean
  dark: boolean
  transport: AuthTransport
  desktop: boolean
  logout: () => Promise<void>
}): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const signOut = async (): Promise<void> => {
    setBusy(true); setError('')
    try { await logout() } catch (failure: unknown) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { fontWeightStrong: 500, colorBgContainer: 'transparent' } }}>
    <Space orientation="vertical" style={{ width: '100%', padding: wide ? '4px 8px' : '4px 0', minWidth: 0, boxSizing: 'border-box' }}>
      {wide && session.user?.display_name && <Typography.Text ellipsis={{ tooltip: session.user.display_name }} style={{ maxWidth: '100%' }}>{session.user.display_name}</Typography.Text>}
      {error && <Alert type="error" title={error} />}
      <Popconfirm title={copy.logoutConfirm} okText={copy.logout} cancelText={copy.cancel} onConfirm={() => { void signOut() }}>
        <Button type="text" block loading={busy} title={copy.logout} aria-label={copy.logout}>{wide ? copy.logout : '↪'}</Button>
      </Popconfirm>
      {!desktop && <DownloadButton transport={transport} compact={!wide} />}
    </Space></ConfigProvider>
}
