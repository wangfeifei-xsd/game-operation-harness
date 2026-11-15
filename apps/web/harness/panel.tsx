/** 登录后显示账号与退出入口；只有真实用户活动才续期。 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Button, ConfigProvider, Popconfirm, Space, Typography, theme } from 'antd'
import { api, copy, type LocalSession } from './shared.ts'
import './style.css'

function UserPanel(): React.ReactElement {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [dark, setDark] = useState(() => document.body.hasAttribute('data-ds-dark-theme'))
  useEffect(() => {
    const observer = new MutationObserver(() => { setDark(document.body.hasAttribute('data-ds-dark-theme')) })
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => { observer.disconnect() }
  }, [])
  useEffect(() => {
    let closed = false
    let lastRenew = 0
    const verify = async (): Promise<void> => {
      try {
        const session = await api<LocalSession>('session')
        if (closed) return
        if (!session.authenticated) { location.replace('/harness/login'); return }
        setName(session.user?.display_name ?? '')
      } catch (_unavailable) { if (!closed) location.replace('/harness/login') }
    }
    const activity = (event: Event): void => {
      if (!event.isTrusted || closed || Date.now() - lastRenew < 15_000) return
      lastRenew = Date.now()
      void api('renew', {}).catch(() => { if (!closed) location.replace('/harness/login') })
    }
    const onVisible = (): void => { if (document.visibilityState === 'visible') void verify() }
    void verify()
    const timer = setInterval(() => { void verify() }, 10_000)
    document.addEventListener('pointerdown', activity, true); document.addEventListener('keydown', activity, true)
    document.addEventListener('visibilitychange', onVisible)
    return () => { closed = true; clearInterval(timer); document.removeEventListener('pointerdown', activity, true); document.removeEventListener('keydown', activity, true); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
  const logout = async (): Promise<void> => {
    setBusy(true)
    try { await api('logout', {}) }
    catch (_remoteUnavailable) { sessionStorage.setItem('harnessLogoutNotice', copy.remoteUnknown) }
    location.replace('/harness/login')
  }
  return <ConfigProvider theme={{ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
    <Space className="harness-user-panel"><Typography.Text ellipsis={{ tooltip: name }}>{name}</Typography.Text>
      <Popconfirm title={copy.logoutConfirm} okText={copy.logout} cancelText={copy.cancel} onConfirm={() => void logout()}>
        <Button size="small" loading={busy}>{copy.logout}</Button>
      </Popconfirm></Space></ConfigProvider>
}
const host = document.createElement('div'); host.id = 'harness-user-panel'; document.body.append(host)
createRoot(host).render(<UserPanel />)
