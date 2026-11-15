/** 只向产品装配的浏览器页面声明产品账号入口，不注入用户或凭据。 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** 固定产品装配开启此入口，原始 profile 保留既有品牌行为。 */
export interface Config {
  /** 产品固定装配启用公开账号入口。 */
  productAccount?: boolean
}

/**
 * @param ctx - 注册页面初始化内容的 Host 上下文。
 * @param config - 固定产品装配提供的公开开关。
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (!config.productAccount) return
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'html', placement: 'head', html: '<meta name="agent-assistant-account" content="enabled">' })
  })
}
