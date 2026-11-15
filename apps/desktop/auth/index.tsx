/** 桌面认证页只使用 preload；窗口转换由主进程负责。 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthPage } from '@deepseek-ai/dsh-client-ui-harness-account/src/AuthPage.tsx'
import { LocalAuthError, type AuthOperation, type AuthTransport,
  type LocalSession } from '@deepseek-ai/dsh-client-ui-harness-account/src/shared.ts'
import '@deepseek-ai/dsh-client-ui-harness-account/style.css'
interface Bridge {
  request(operation: string,
    body?: object): Promise<{ ok: true; value: unknown } | { ok: false; error: { status: number; message: string } }>
  subscribe(listener: (state: LocalSession) => void): () => void
}
declare global { interface Window { agentAssistantAccount: Bridge } }
const transport: AuthTransport = {
  async request<T>(operation: AuthOperation, data?: object, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const result = await window.agentAssistantAccount.request(operation, data)
    signal?.throwIfAborted()
    if (!result.ok) throw new LocalAuthError(result.error.status, result.error.message)
    return result.value as T
  },
}
function DesktopAuth(): React.ReactElement {
  const [state, setState] = useState<LocalSession>({ authenticated: false, state: 'signedOut' })
  useEffect(() => {
    const release = window.agentAssistantAccount.subscribe(setState)
    void transport.request<LocalSession>('session').then(setState)
    return release
  }, [])
  return <AuthPage transport={transport} notice={state.error?.message ?? ''} phase={state.state} onAuthenticated={() => undefined} />
}
createRoot(document.getElementById('root')!).render(<DesktopAuth />)
