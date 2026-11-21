/** 产品账号摘要与模型授权分开显示；导航和状态订阅由载体拥有。 */
import React, { useState } from 'react'
import { Alert, Avatar, Badge, Button, ConfigProvider, Popconfirm, Typography, theme } from 'antd'
import LogoutOutlined from '@ant-design/icons/es/icons/LogoutOutlined'
import UserOutlined from '@ant-design/icons/es/icons/UserOutlined'
import { BusinessAssistant } from './BusinessAssistant.tsx'
import { DownloadButton } from './DownloadButton.tsx'
import { copy, errorText, type AuthTransport, type LocalSession } from './shared.ts'
import css from './AccountControls.module.css'

/**
 * 两端共用账号卡片；窄栏以可访问名称保留退出和下载操作。
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
  const themeKey = dark ? 'harness-account-dark' : 'harness-account-light'
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    cssVar: { key: themeKey }, token: { fontWeightStrong: 500, fontSize: 13, borderRadius: 8 } }}>
    <div className={`${css.root} ${themeKey}`} data-wide={wide}>
      <div className={css.card}>
        {wide && <>
          <Avatar className={css.avatar as string} shape="square" size={36} icon={<UserOutlined />} aria-hidden="true" />
          <div className={css.identity}>
            {session.user?.display_name && <Typography.Text ellipsis={{ tooltip: session.user.display_name }}
              className={css.name as string}>{session.user.display_name}</Typography.Text>}
            {session.authenticated && <Badge className={css.status as string} status="success" text={copy.signedIn} />}
          </div>
        </>}
        <Popconfirm title={copy.logoutConfirm} okText={copy.logout} cancelText={copy.cancel} onConfirm={() => { void signOut() }}>
          <Button className={css.logout as string} type="text" loading={busy} title={copy.logout} aria-label={copy.logout}
            icon={<LogoutOutlined />}>{wide ? copy.logout : null}</Button>
        </Popconfirm>
      </div>
      {error && <Alert type="error" title={error} />}
      {session.authenticated && <BusinessAssistant compact={!wide} />}
      {!desktop && <DownloadButton transport={transport} compact={!wide} />}
    </div></ConfigProvider>
}
