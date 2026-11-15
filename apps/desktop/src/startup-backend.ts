import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** 桌面启动偏好读取，独立于供应商授权与模型配置。 */

import { randomUUID } from 'node:crypto'

/** Metadata needed before the native entry or workspace becomes visible. */
export interface DesktopStartupState {
  readonly localePreference: string | null
  /** Effective Host theme preference; absent or invalid optional theme settings use system appearance. */
  readonly themePreference: 'light' | 'dark' | 'system'
}

/** Narrow operations available to the desktop startup flow. */
export interface DesktopStartupBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns 共享语言与主题偏好。 */
  read(): Promise<DesktopStartupState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>

}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Connect the native HTTP client to the Desktop Host; every request sends `cookie` explicitly and uses no cookie jar.
 * @param hostUrl - URL of the running Desktop Host; only its origin is used.
 * @param cookie - Desktop-private authentication header for this owned Host.
 * @param send - HTTP client for Host requests.
 * @returns 通用偏好读取和埋点提交 over standard RPC.
 */
export function connectDesktopStartup(
  hostUrl: string,
  cookie: string,
  send: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): DesktopStartupBackend {
  const origin = new URL(hostUrl).origin
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = `${request.namespace}/${request.method}`
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop startup: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result)) {
      throw new Error('桌面启动：设置响应格式无效')
    }
    if (envelope.result.ok !== true) {
      const error = envelope.result.error
      const code = record(error) && typeof error.code === 'string' ? error.code : 'invalid-result'
      throw new Error(`桌面启动：${method} 请求失败（${code}）`)
    }
    return envelope.result.value
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop startup: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  const themePreference = (namespaces: unknown[]): DesktopStartupState['themePreference'] => {
    const theme = namespaces.find(item => record(item) && item.ns === 'ui-theme')
    if (theme === undefined) return 'system'
    const preference = record(theme) && record(theme.value) ? theme.value.preference : undefined
    if (preference === 'light' || preference === 'dark' || preference === 'system') return preference
    console.warn('desktop appearance: invalid Host theme preference; using system appearance')
    return 'system'
  }
  const read = async (): Promise<DesktopStartupState> => {
    const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
    if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('桌面启动：设置读取失败')
    const namespaces = settings.namespaces
    return {
      localePreference: localePreference(namespaces),
      themePreference: themePreference(namespaces),
    }
  }
  return {
    read,
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() {
      const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
      if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop startup: missing settings namespaces')
      return localePreference(settings.namespaces)
    },
  }
}
