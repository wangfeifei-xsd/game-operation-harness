/** 产品模型列表与单模型表单；业务校验和密钥归属由 Host 决定。 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Checkbox, Collapse, ConfigProvider, Empty, Form, Input, InputNumber, Modal, Select, Space, Table,
  Tag, theme, Typography } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import jaJP from 'antd/locale/ja_JP'
import esES from 'antd/locale/es_ES'
import frFR from 'antd/locale/fr_FR'
import deDE from 'antd/locale/de_DE'
import ruRU from 'antd/locale/ru_RU'
import ptBR from 'antd/locale/pt_BR'
import type { HostObservable, InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { IconDataOutlineRegular, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  HarnessModelId, ModelConfigInput, ModelConfigSnapshot, ModelConfigView, ModelConnectionResult, ModelProtocol,
} from '@deepseek-ai/dsh-harness-model-config/types'
import type { DirectOperations, DirectPageState } from './direct-page.ts'
import type { DirectModelKey } from './direct-locales.ts'
import css from './DirectModels.module.css'
import deepseek from './assets/deepseek.svg'
import doubao from './assets/doubao.svg'
import qwen from './assets/qwen.svg'
import openai from './assets/openai.svg'
import anthropic from './assets/anthropic.svg'
import google from './assets/gemini.svg'

const reasoningLabels: Record<string, DirectModelKey> = { off: 'off', minimal: 'minimal', low: 'low', medium: 'medium',
  high: 'high', xhigh: 'xhigh', max: 'max' }
const icons: Record<string, string> = { deepseek, doubao, qwen, openai, anthropic, google }
const componentLocales: Record<string, typeof enUS> = { en: enUS, zh: zhCN, ja: jaJP, es: esES, fr: frFR, de: deDE, ru: ruRU, pt: ptBR }

/** 组件所有外部数据均由注册处注入。 */
export interface DirectModelsInjected {
  operations: DirectOperations
  t: TranslateNS<'models.direct'>
  hooks: { snapshot: HostObservable<DirectPageState>; theme: HostObservable<ThemeSnapshot>; locale: HostObservable<LocaleSnapshot> }
}

function ProviderIcon({ provider }: { provider: string }) {
  const src = icons[provider]
  return src ? <img className={`${css.icon} ${provider === 'openai' ||
    provider === 'anthropic' ? css.monochrome : ''}`} src={src} alt="" /> : <IconDataOutlineRegular size={20} />
}

type Draft = ModelConfigInput

type Editor = { model: ModelConfigView | null; revision: number }
type Removal = { model: ModelConfigView; action: 'remove' | 'disable'; revision: number }
type Confirmation = { title: string; settle: (accepted: boolean) => void }

/** antd 弹窗与设置壳共享焦点栈，避免 Escape 和 Tab 作用于后方窗口。 */
function ModalKeyboardLayer({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLElement | null>(null)
  useModalLayer(dialog, true, onClose)
  return <div ref={(element) => {
    dialog.current = element?.querySelector<HTMLElement>('[role="dialog"]') ?? element?.closest<HTMLElement>('[role="dialog"]') ?? null
  }}>{children}</div>
}

/**
 * 显示单模型列表及编辑器。
 * @param props - 设置分区和数据、主题、操作。
 * @returns 模型配置页面。
 */
export function DirectModelsSection({ operations, t, useSnapshot, useTheme,
  useLocale }: InjectFace<DirectModelsInjected> & PropsRuntime<'settings.section'>) {
  const state = useSnapshot(value => value)
  const palette = useTheme(value => value)
  const locale = useLocale(value => value.active)
  const data = state.data
  const [editor, setEditor] = useState<Editor | null>(null)
  const [removal, setRemoval] = useState<Removal | null>(null)
  const [replacement, setReplacement] = useState<HarnessModelId>()
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<ModelConnectionResult | null>(null)
  const [form] = Form.useForm<Draft>()
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const confirmationRef = useRef(confirmation)
  confirmationRef.current = confirmation
  const [dirty, setDirty] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string>()
  const [advanced, setAdvanced] = useState<string[]>([])
  const generation = useRef(state.generation)
  generation.current = state.generation
  const providerKey = Form.useWatch('providerKey', form)
  const modelIdentifier = Form.useWatch('model', form)
  const protocol = Form.useWatch('protocol', form)
  const baseUrl = Form.useWatch('baseUrl', form)
  const provider = data?.providers.find(item => item.key === providerKey)
  const hint = data?.modelHints.find(item => item.providerKey === providerKey
    && item.model === modelIdentifier && item.protocol === protocol)
  const unknownModel = typeof modelIdentifier === 'string' && modelIdentifier.trim().length > 0 && hint === undefined
  const others = removal === null ? [] : data?.models.filter(item => item.enabled && item.id !== removal.model.id) ?? []
  const needsReplacement = removal !== null && data?.defaultId === removal.model.id && others.length > 0

  useEffect(() => { void operations.load() }, [operations])
  useEffect(() => {
    form.resetFields(); setEditor(null); setRemoval(null); setError(null); setBusy(false); setTesting(false); setTestResult(null)
    confirmationRef.current?.settle(false); setConfirmation(null)
  }, [state.generation, form])
  useEffect(() => () => { confirmationRef.current?.settle(false) }, [])
  useEffect(() => { if (unknownModel) setAdvanced(['advanced']) }, [unknownModel])

  const confirm = (title: string): Promise<boolean> => new Promise((settle) => {
    confirmationRef.current?.settle(false)
    setConfirmation({ title, settle })
  })
  const settleConfirmation = (accepted: boolean) => { confirmation?.settle(accepted); setConfirmation(null) }
  const openEditor = (model: ModelConfigView | null, snapshot = data) => {
    if (snapshot === null) return
    setSelectedProvider(model?.providerKey); setEditor({ model, revision: snapshot.revision }); setDirty(false); setError(null)
    setAdvanced([])
    form.resetFields()
    form.setFieldsValue(model === null ? { timeoutSeconds: 60, imageInput: false } : {
      name: model.name, providerKey: model.providerKey, protocol: model.protocol, baseUrl: model.baseUrl, model: model.model,
      timeoutSeconds: model.timeoutSeconds, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens,
      imageInput: model.imageInput, reasoningEffort: model.reasoningEffort,
    })
  }
  const closeEditor = async () => {
    if (busy) return
    const started = state.generation
    if (dirty && !await confirm(t('discard'))) return
    if (generation.current !== started) return
    form.resetFields(); setEditor(null); setError(null)
  }
  const reloadEditor = async () => {
    if (busy || editor === null) return
    const started = state.generation
    if (dirty && !await confirm(t('reloadDraft'))) return
    if (generation.current !== started) return
    setBusy(true)
    try {
      const snapshot: ModelConfigSnapshot | null = await operations.load()
      if (snapshot === null || generation.current !== started) return
      const model = editor.model === null ? null : snapshot.models.find(item => item.id === editor.model?.id)
      if (model === undefined) { form.resetFields(); setEditor(null); setError(t('removed')); return }
      openEditor(model, snapshot)
    } finally { if (generation.current === started) setBusy(false) }
  }
  const save = async (values: Draft) => {
    if (editor === null || busy) return
    const started = state.generation
    setBusy(true); setError(null)
    try {
      const result = await operations.save({ ...values, ...editor.model === null ? {} : { id: editor.model.id } }, editor.revision)
      if (generation.current !== started) return
      if (result.ok) { form.resetFields(); setEditor(null); setDirty(false) }
      else {
        setError(result.error.message)
        if (result.error.code === 'model-config/rejected' && result.error.details.field !== null) {
          const field = result.error.details.field
          if (!isDraftField(field)) return
          form.setFields([{ name: field, errors: [result.error.message] }])
          if (['contextWindow', 'maxOutputTokens', 'reasoningEffort'].includes(field)) setAdvanced(['advanced'])
          form.scrollToField(field)
        }
      }
    } catch (_error) { if (generation.current === started) setError(t('failed')) }
    finally { if (generation.current === started) setBusy(false) }
  }
  const run = async (operation: () => ReturnType<DirectOperations['setDefault']>) => {
    if (busy) return
    const started = state.generation
    setBusy(true); setError(null)
    try {
      const result = await operation()
      if (generation.current !== started) return
      if (!result.ok) setError(result.error.message)
      else setRemoval(null)
    }
    catch (_error) { if (generation.current === started) setError(t('failed')) }
    finally { if (generation.current === started) setBusy(false) }
  }
  const changeProvider = async (key: string) => {
    const started = state.generation
    const next = data?.providers.find(item => item.key === key)
    if (next === undefined) return
    const previous = data?.providers.find(item => item.key === selectedProvider)
    const previousKey = selectedProvider
    const address = form.getFieldValue('baseUrl') as string | undefined
    const original = previous
    if (address && address !== (original?.baseUrl ?? editor?.model?.baseUrl) && address !== next.baseUrl) {
      const confirmed = await confirm(t('changeProvider'))
      if (generation.current !== started) return
      if (!confirmed) { form.setFieldValue('providerKey', previousKey); return }
    }
    form.setFieldsValue({ providerKey: key, baseUrl: next.baseUrl, protocol: next.defaultProtocol, apiKey: '', reasoningEffort: undefined })
    setSelectedProvider(key); setDirty(true)
  }
  const protocolLabels: Record<ModelProtocol, DirectModelKey> = { 'openai-completions': 'completions',
    'openai-responses': 'responses', 'anthropic-messages': 'messages', 'google-generative-ai': 'generate' }
  const isCurrentTest = testResult !== null && testResult.revision === data?.revision
  const test = async (model: ModelConfigView) => {
    if (data === null || busy) return
    const started = state.generation
    setBusy(true); setTesting(true); setError(null); setTestResult(null)
    try {
      const result = await operations.test({ id: model.id, expectedRevision: data.revision })
      if (generation.current !== started) return
      if (result.ok) setTestResult(result.value)
      else setError(result.error.message)
    }
    catch (_error) { if (generation.current === started) setError(t('failed')) }
    finally { if (generation.current === started) { setBusy(false); setTesting(false) } }
  }
  const originalModel = editor?.model
  const keyRequired = !originalModel || originalModel.providerKey !== providerKey
    || originOf(originalModel.baseUrl) !== originOf(baseUrl) || !originalModel.credentialConfigured
  return <ConfigProvider locale={componentLocales[locale] ?? enUS} button={{ autoInsertSpace: false }} theme={{ algorithm: palette.active.colorScheme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: { fontSize: 13, fontWeightStrong: 500, borderRadius: 8, motion: false } }}><div className={css.page}>
      <div className={css.heading}><Typography.Title level={4}>{t('title')}</Typography.Title><Button type="primary" disabled={data === null || busy} onClick={() => { openEditor(null) }}>{t('add')}</Button></div>
      {state.error && <Alert type="error" title={state.error} action={<Button onClick={() => { void operations.load() }}>{t('retry')}</Button>} />}
      {error && editor === null &&
        <Alert type="error" title={error} action={<Button onClick={() => { void operations.load() }}>{t('reload')}</Button>} />}
      {data?.cleanupPending && <Alert type="warning" title={t('cleanup')} />}
      {data?.runtimeError && <Alert type="error" title={data.runtimeError} />}
      {testing && <Button onClick={() => { operations.cancelTest() }}>{t('cancel')}</Button>}
      {isCurrentTest && <Alert type={testResult.status === 'connected' ? 'success' : 'warning'} title={testResult.message} description={`${t('duration')}：${testResult.elapsedMs} · ${t('checkedAt')}：${formatCheckTime(testResult.checkedAt, t('checkTimeFormat'))}`} />}
      <Table<ModelConfigView> rowKey="id" size="small" loading={state.loading} dataSource={data?.models ?? []} pagination={false} scroll={{ x: 760 }}
        locale={{ emptyText: <Empty description={t('empty')}><Button disabled={data === null} onClick={() => { openEditor(null) }}>{t('add')}</Button></Empty> }} columns={[
          { title: t('name'), dataIndex: 'name', width: 170, ellipsis: { showTitle: true }, render: (name: string,
            model) => <Space size={4}><Typography.Text ellipsis={{ tooltip: name }}>{name}</Typography.Text>{data?.defaultId === model.id && <Tag>{t('default')}</Tag>}</Space> },
          { title: t('provider'), width: 132, render: (_, model) => <Space size={6}>
            <ProviderIcon provider={model.providerKey} />{data?.providers.find(item => item.key === model.providerKey)?.name}
          </Space> },
          { title: t('model'), dataIndex: 'model', width: 165, ellipsis: { showTitle: true } },
          { title: t('state'), width: 90, render: (_,
            model) => !model.credentialConfigured ? t('unavailable') : model.enabled ? t('enabled') : t('disabled') },
          { title: t('actions'), width: 235, render: (_, model) => <Space wrap size={[0, 0]}>
            <Button type="link" size="small" disabled={busy} onClick={() => { openEditor(model) }}>{t('edit')}</Button>
            <Button type="link" size="small" disabled={busy} onClick={() => { void test(model) }}>{t('test')}</Button>
            {model.enabled && data?.defaultId !== model.id &&
              <Button type="link" size="small" disabled={busy} onClick={() => { void run(() => operations.setDefault({ id: model.id, expectedRevision: data?.revision ?? -1 })) }}>{t('setDefault')}</Button>}
            <Button type="link" size="small" disabled={busy} onClick={() => {
              if (data === null) return
              if (model.enabled) { setRemoval({ model, action: 'disable',
                revision: data.revision }); setReplacement(undefined); setError(null) }
              else void run(() => operations.setEnabled({ id: model.id, expectedRevision: data.revision }, true))
            }}>{t(model.enabled ? 'disable' : 'enable')}</Button>
            <Button type="link" danger size="small" disabled={busy} onClick={() => { if (data !== null) { setRemoval({ model, action: 'remove', revision: data.revision }); setReplacement(undefined); setError(null) } }}>{t('remove')}</Button>
          </Space> },
        ]} />
      <Modal title={editor?.model ? t('edit') : t('add')} open={editor !== null} onCancel={() => { void closeEditor() }} width={560} zIndex={1100}
        okText={t('save')} cancelText={t('cancel')} confirmLoading={busy} onOk={() => { form.submit() }}
        cancelButtonProps={{ disabled: busy }} mask={{ closable: false }} destroyOnHidden keyboard={false}
        modalRender={node => <ModalKeyboardLayer onClose={() => { void closeEditor() }}>{node}</ModalKeyboardLayer>}>
        {error && <Alert className={css.feedback ?? ''} type="error" title={error}
          action={<Button disabled={busy} onClick={() => { void reloadEditor() }}>{t('reload')}</Button>} />}
        <Form form={form} layout="vertical" disabled={busy} onFinish={(values) => { void save(values) }} onValuesChange={(changed) => {
          setDirty(true)
          if ('model' in changed || 'protocol' in changed) form.setFieldValue('reasoningEffort', undefined)
        }} autoComplete="off">
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true,
            message: t('required') }]}><Input data-modal-autofocus /></Form.Item>
          <Form.Item name="providerKey" label={t('provider')} rules={[{ required: true, message: t('required') }]}>
            <Select<string> virtual={false} getPopupContainer={(trigger: HTMLElement) => trigger.parentElement ?? trigger}
              onSelect={(key) => { void changeProvider(key) }} options={(data?.providers ?? []).map(item => ({
                value: item.key, label: <Space><ProviderIcon provider={item.key} />{item.name}</Space>,
              }))} />
          </Form.Item>
          <Form.Item name="baseUrl" label={t('baseUrl')} rules={[{ required: true, whitespace: true,
            message: t('required') }]}><Input spellCheck={false} /></Form.Item>
          <Form.Item name="apiKey" label={t('key')} rules={[{ required: keyRequired, whitespace: true, message: t('required') }]}>
            <Input.Password autoComplete="new-password" placeholder={originalModel?.credentialConfigured ? t('keyConfigured') : undefined} />
          </Form.Item>
          <Form.Item name="model" label={t('model')} rules={[{ required: true, whitespace: true,
            message: t('required') }]}><Input spellCheck={false} /></Form.Item>
          <Collapse activeKey={advanced} onChange={(key) => { setAdvanced(typeof key === 'string' ? [key] : key) }} items={[{ key: 'advanced', label: t('advanced'), forceRender: true, children: <>
            <Form.Item name="protocol" label={t('protocol')} rules={[{ required: true,
              message: t('required') }]}><Select getPopupContainer={(trigger: HTMLElement) => trigger.parentElement ?? trigger} options={(provider?.protocols ?? []).map(value => ({ value, label: t(protocolLabels[value]) }))} /></Form.Item>
            <Form.Item name="timeoutSeconds" label={t('timeout')} rules={[{ required: true,
              message: t('required') }]}><InputNumber min={1} precision={0} className={css.fullWidth ?? ''} /></Form.Item>
            <Form.Item name="contextWindow" label={t('context')} rules={[{ required: unknownModel,
              message: t('required') }]}><InputNumber min={1} precision={0} placeholder={hint === undefined ? undefined : String(hint.contextWindow)} className={css.fullWidth ?? ''} /></Form.Item>
            <Form.Item name="maxOutputTokens" label={t('output')} rules={[{ required: unknownModel,
              message: t('required') }]}><InputNumber min={1} precision={0} placeholder={hint === undefined ? undefined : String(hint.maxOutputTokens)} className={css.fullWidth ?? ''} /></Form.Item>
            <Form.Item name="imageInput" valuePropName="checked"><Checkbox>{t('images')}</Checkbox></Form.Item>
            {(hint?.reasoningEfforts.length ?? 0) > 0 &&
              <Form.Item name="reasoningEffort" label={t('reasoning')}><Select getPopupContainer={(trigger: HTMLElement) => trigger.parentElement ?? trigger} allowClear placeholder={t('providerDefault')} options={(hint?.reasoningEfforts ?? []).map(value => ({ value, label: t(reasoningLabels[value] ?? 'providerDefault') }))} /></Form.Item>}
          </> }]} />
        </Form>
      </Modal>
      <Modal title={t(removal?.action === 'remove' ? 'confirmRemove' : 'confirmDisable')} open={removal !== null} zIndex={1100}
        onCancel={() => { if (!busy) setRemoval(null) }} keyboard={false}
        modalRender={node => <ModalKeyboardLayer onClose={() => { if (!busy) setRemoval(null) }}>{node}</ModalKeyboardLayer>}
        okText={t('confirm')} cancelText={t('cancel')} confirmLoading={busy}
        okButtonProps={{ danger: true, disabled: needsReplacement && replacement === undefined }} onOk={() => {
          if (removal === null) return
          const request = { id: removal.model.id, expectedRevision: removal.revision,
            ...replacement === undefined ? {} : { replacementDefaultId: replacement } }
          void run(() => removal.action === 'remove' ? operations.remove(request) : operations.setEnabled(request, false))
        }}>
        {error && <Alert className={css.feedback ?? ''} type="error" title={error}
          action={<Button disabled={busy} onClick={() => { setRemoval(null); void operations.load() }}>{t('reload')}</Button>} />}
        <Typography.Paragraph>{removal?.model.name}</Typography.Paragraph>
        {needsReplacement &&
          <div><Typography.Text>{t('replacement')}</Typography.Text><Select getPopupContainer={(trigger: HTMLElement) => trigger.parentElement ?? trigger} aria-label={t('replacement')} className={css.fullWidth ?? ''} value={replacement} onChange={setReplacement} options={others.map(item => ({ value: item.id, label: item.name }))} /></div>}
      </Modal>
      <Modal title={confirmation?.title} open={confirmation !== null} keyboard={false} zIndex={1200}
        onCancel={() => { settleConfirmation(false) }} onOk={() => { settleConfirmation(true) }}
        okText={t('confirm')} cancelText={t('cancel')}
        modalRender={node => <ModalKeyboardLayer onClose={() => { settleConfirmation(false) }}>{node}</ModalKeyboardLayer>} />
    </div></ConfigProvider>
}

function formatCheckTime(value: string, pattern: string): string {
  const date = new Date(value)
  const values: Record<string, string> = { year: String(date.getFullYear()), month: String(date.getMonth() + 1),
    day: String(date.getDate()),
    hour: String(date.getHours()).padStart(2, '0'), minute: String(date.getMinutes()).padStart(2, '0'),
    second: String(date.getSeconds()).padStart(2, '0') }
  return pattern.replace(/\{(\w+)\}/gu, (match, key: string) => values[key] ?? match)
}

function originOf(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try { return new URL(value).origin } catch (_error) { return undefined }
}

function isDraftField(field: string): field is keyof Draft {
  return ['name', 'providerKey', 'protocol', 'baseUrl', 'model', 'apiKey', 'timeoutSeconds', 'contextWindow',
    'maxOutputTokens', 'imageInput', 'reasoningEffort'].includes(field)
}
