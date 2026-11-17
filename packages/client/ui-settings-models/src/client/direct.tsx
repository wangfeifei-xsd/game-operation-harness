/** 产品模型页面注册和同一设置窗口的快捷入口。 */
import { Button, ConfigProvider, Tooltip, theme } from 'antd'
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable, InjectFace, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { IconDataOutlineRegular, IconSettingsOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { DirectModelsPage } from './direct-page.ts'
import { DirectModelsSection, type DirectModelsInjected } from './DirectModelsSection.tsx'
import { en, zh, type DirectModelKey } from './direct-locales.ts'
import css from './DirectModels.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'models.direct': DirectModelKey }
}

type LauncherInjected = { t: TranslateNS<'models.direct'>; hooks: { theme: HostObservable<ThemeSnapshot> } }
function ModelLauncher({ wide, openSettings, t, useTheme }: PropsRuntime<'settings.launcher'> & InjectFace<LauncherInjected>) {
  const palette = useTheme(value => value)
  return <ConfigProvider theme={{ algorithm: palette.active.colorScheme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm }}>
    <div className={css.launcher} data-wide={wide}>
      <Tooltip title={wide ? undefined : t('title')}><Button type="text" aria-label={t('title')} icon={<IconDataOutlineRegular size={18} />} onClick={() => { openSettings('models') }}>{wide ? t('title') : undefined}</Button></Tooltip>
      <Tooltip title={wide ? undefined : t('settings')}><Button type="text" aria-label={t('settings')} icon={<IconSettingsOutlineRegular size={18} />} onClick={() => { openSettings() }}>{wide ? t('settings') : undefined}</Button></Tooltip>
    </div>
  </ConfigProvider>
}
function ConfigureModel({ dismiss, openModels, t }: PropsRuntime<'conversation.input.model.options'> & { openModels: () => void; t: TranslateNS<'models.direct'> }) {
  return <Button type="text" block onClick={() => { dismiss(); openModels() }}>{t('title')}</Button>
}

/**
 * 仅产品装配启用，通用上游 profile 继续使用自己的配置编辑器。
 * @param ctx - 声明了模型 Remote 与主题的插件上下文。
 */
export function applyDirectModels(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('models.direct', { zh, en }), '模型配置：文案')
  const t = ctx.locale.bind('models.direct')
  const page = new DirectModelsPage(ctx, () => t('loadFailed'))
  const operations = page.operations()
  const themeSource = { getSnapshot: () => ctx.theme.getTheme(), subscribe: (listener: () => void) => ctx.on('theme/change', listener) }
  const injected = (): DirectModelsInjected => ({ operations, t, hooks: { snapshot: page.store, theme: themeSource, locale: ctx.locale } })
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'models', order: 10, label: () => t('nav'), inject: injected }, DirectModelsSection))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({ name: 'settings.launcher', inject: (): LauncherInjected => ({ t, hooks: { theme: themeSource } }) }, ModelLauncher))
  ctx.slots.inject('conversation.input.model.options', () => ctx.slots.register({
    name: 'conversation.input.model.options', id: 'model-configuration',
    inject: () => ({ t, openModels: () => { ctx.emit('settings/open', 'models') } }),
  }, ConfigureModel))
  ctx.effect(() => ctx.remote.$on('model-config/changed', () => { if (page.store.getSnapshot().data !== null) void page.load() }))
  ctx.on('connection/reset', () => { const loaded = page.store.getSnapshot().data !== null; page.reset(); if (loaded) void page.load() })
  ctx.effect(() => () => { page.reset() })
}
