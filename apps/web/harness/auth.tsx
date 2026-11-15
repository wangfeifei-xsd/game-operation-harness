/** Harness 独立登录、注册和用途绑定的滑块验证码页面。 */
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Alert, Button, Card, ConfigProvider, Form, Input, Modal, Slider, Space, Spin, Tabs, Typography, type ThemeConfig } from 'antd'
import { CatLogo } from '@deepseek-ai/dsh-client-ui-primitives/src/CatLogo.tsx'
import { api, copy, errorText, type LocalSession } from './shared.ts'
import './style.css'

const authTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2454f3', colorText: '#23242c', colorTextSecondary: '#66676d',
    colorBorder: '#c6c8cf', borderRadius: 8, controlHeight: 40, fontSize: 18, fontWeightStrong: 500,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Button: { primaryShadow: 'none', defaultShadow: 'none' },
    Form: { labelFontSize: 18, labelColor: '#23242c' },
    Tabs: { titleFontSize: 20, horizontalItemGutter: 14, inkBarColor: '#2454f3', itemColor: '#66676d' },
  },
}

interface Challenge {
  challenge_id: string
  background: string
  piece: string
  piece_y: number
  piece_size: number
  width: number
  height: number
}
interface Fields { login_name: string; display_name?: string; password: string }

function AuthPage(): React.ReactElement {
  const [form] = Form.useForm<Fields>()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState(() => { const message = sessionStorage.getItem('harnessLogoutNotice') ?? ''; sessionStorage.removeItem('harnessLogoutNotice'); return message })
  const [challenge, setChallenge] = useState<Challenge>()
  const [verifying, setVerifying] = useState(false)
  const [captchaOpen, setCaptchaOpen] = useState(false)
  const [offset, setOffset] = useState(0)
  const [proof, setProof] = useState('')
  const request = useRef<AbortController | undefined>(undefined)
  const operation = useRef(0)
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const name = Form.useWatch('login_name', form)
  const clearCaptcha = (): void => { request.current?.abort(); clearTimeout(expiry.current); setProof(''); setChallenge(undefined); setCaptchaOpen(false); setVerifying(false) }
  useEffect(() => { clearCaptcha() }, [name, mode])
  useEffect(() => {
    const controller = new AbortController()
    void api<LocalSession>('session', undefined, controller.signal).then((session) => {
      if (session.authenticated) location.replace('/')
      else if (session.error) setError(session.error.message)
    }).catch((error) => { if (!controller.signal.aborted) setError(errorText(error)) })
    return () => { controller.abort(); request.current?.abort(); clearTimeout(expiry.current) }
  }, [])
  const loadCaptcha = async (): Promise<void> => {
    try { await form.validateFields(['login_name']) } catch (_invalidField) { return }
    request.current?.abort()
    const controller = new AbortController(); request.current = controller
    setVerifying(true); setChallenge(undefined); setProof(''); setOffset(0); setCaptchaOpen(true); setError('')
    try {
      const value = await api<Challenge>(`captcha/${mode}/challenges`, { login_name: name }, controller.signal)
      if (!controller.signal.aborted) setChallenge(value)
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)) }
    finally { if (!controller.signal.aborted) setVerifying(false) }
  }
  const verify = async (position: number): Promise<void> => {
    if (challenge === undefined || verifying) return
    const controller = new AbortController(); request.current = controller; setVerifying(true)
    try {
      const result = await api<{ captcha_token: string; expires_in: number }>(`captcha/${mode}/verify`, { challenge_id: challenge.challenge_id, offset: position }, controller.signal)
      if (controller.signal.aborted) return
      setProof(result.captcha_token); setCaptchaOpen(false)
      clearTimeout(expiry.current)
      expiry.current = setTimeout(() => { setProof('') }, result.expires_in * 1000)
    } catch (error) { if (!controller.signal.aborted) { setError(errorText(error)); setChallenge(undefined) } }
    finally { if (!controller.signal.aborted) setVerifying(false) }
  }
  const submit = async (fields: Fields): Promise<void> => {
    if (!proof) { setError(copy.captchaRequired); return }
    const generation = ++operation.current
    setBusy(true); setError(''); setNotice('')
    try {
      await api(mode, { login_name: fields.login_name, password: fields.password, captcha_token: proof,
        ...(mode === 'register' ? { display_name: fields.display_name } : {}) })
      if (generation !== operation.current) return
      if (mode === 'login') location.replace('/')
      else { setMode('login'); setNotice(copy.registered); form.setFieldValue('password', '') }
    } catch (error) { if (generation === operation.current) setError(errorText(error)) }
    finally { if (generation === operation.current) { setBusy(false); clearCaptcha() } }
  }
  const cancel = async (): Promise<void> => {
    ++operation.current
    setError('')
    try { await api('logout', {}) } catch (error) { setError(errorText(error)) }
    finally { setBusy(false); clearCaptcha() }
  }
  return <ConfigProvider theme={authTheme}><main className="harness-auth-page">
    <Card className={`harness-auth-card harness-auth-card-${mode}`}>
      <aside className="harness-auth-brand-panel" aria-hidden="true">
        <div className="harness-auth-brand"><CatLogo size={72} /><span>Harness</span></div>
        <CatLogo size={380} className="harness-auth-watermark" />
      </aside>
      <section className="harness-auth-panel" aria-labelledby="harness-auth-title"><div className="harness-auth-content">
        <Typography.Title id="harness-auth-title" level={2}>Harness</Typography.Title>
        <Tabs activeKey={mode} onChange={(key) => { setMode(key as 'login' | 'register'); setError(''); setNotice('') }} items={[
          { key: 'login', label: copy.login, disabled: busy }, { key: 'register', label: copy.register, disabled: busy },
        ]} />
        {error && <Alert type="error" title={error} showIcon />}{notice && <Alert type="success" title={notice} showIcon />}
        <Form form={form} layout="vertical" onFinish={fields => void submit(fields)} disabled={busy} autoComplete="on">
          <Form.Item name="login_name" label={copy.account} rules={[{ required: true, whitespace: true, message: copy.required }, { min: 3, max: 128, message: copy.required }]}>
            <Input autoComplete="username" maxLength={128} />
          </Form.Item>
          {mode === 'register' && <Form.Item name="display_name" label={copy.name} rules={[{ required: true, whitespace: true, message: copy.required }]}><Input maxLength={128} autoComplete="nickname" /></Form.Item>}
          <Form.Item name="password" label={copy.password} rules={[{ required: true, message: copy.required }, { min: 12, max: 256, message: copy.passwordLength }]}>
            <Input.Password autoComplete={mode === 'login' ? 'current-password' : 'new-password'} maxLength={256} />
          </Form.Item>
          <Button className="harness-auth-verify" block onClick={() => void loadCaptcha()} disabled={busy}>{proof ? copy.verified : copy.verify}</Button>
          <Button className="harness-submit" block type="primary" htmlType="submit" loading={busy}>{copy[mode]}</Button>
        </Form>
        {busy && <Button block onClick={() => void cancel()}>{copy.cancelLogin}</Button>}
      </div></section>
    </Card>
    <Modal title={copy.captcha} open={captchaOpen} onCancel={clearCaptcha} footer={null} width={388} destroyOnHidden>
      <p>{copy.drag}</p><div className="harness-captcha">
        {challenge && <><img src={challenge.background} alt={copy.image} draggable={false} />
          <img src={challenge.piece} alt={copy.piece} draggable={false} className="harness-captcha-piece" style={{ width: `${challenge.piece_size / challenge.width * 100}%`, top: `${challenge.piece_y / challenge.height * 100}%`, left: `${offset / challenge.width * 100}%` }} /></>}
        {verifying && <Spin />}
      </div>
      <Slider ariaLabelForHandle={copy.position} min={0} max={challenge ? challenge.width - challenge.piece_size : 268}
        value={offset} onChange={setOffset}
        onChangeComplete={position => void verify(position)} disabled={!challenge || verifying} tooltip={{ open: false }} />
      <Space><Button onClick={() => void loadCaptcha()} disabled={verifying}>{copy.refresh}</Button>
        <Button onClick={() => void verify(offset)} disabled={!challenge || verifying}>{copy.confirm}</Button></Space>
    </Modal>
  </main></ConfigProvider>
}

createRoot(document.getElementById('root')!).render(<AuthPage />)
