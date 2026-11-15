/** Public page-bootstrap options shared by the Host and Client halves. */

import z from '@deepseek-ai/schemastery'

/** Onboarding options after schema defaults are applied. */
export interface Config {
  /** 产品直接模型配置模式，不读取旧配置和授权。 */
  directModels?: boolean
  /** Offer the browser API-key step when no native shell owns credential onboarding. */
  credentialOnboarding: boolean
}

/** Validate Host configuration and its public page-bootstrap payload. */
export const Config: z<Partial<Config>, Config> = z.object({
  directModels: z.boolean().default(false),
  credentialOnboarding: z.boolean().default(true),
})

/** Page-global key carrying only the public onboarding options. */
export const ONBOARDING_CONFIG_GLOBAL = '__DSH_MODELS_ONBOARDING__'
