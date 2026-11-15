/** Agent 助手 的侧栏、首屏标识和点击触发的猫头动效。 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { ProductAccount } from './product-account.ts'
import { ProductAccountFooter } from './ProductAccountFooter.tsx'
import { PixelCat } from './home-cat/PixelCat.tsx'
import { GameOperationBrandMark, GameOperationBrandName } from './Brand.tsx'

/** 只依赖槽位注册服务。 */
export const inject = ['slots']

/**
 * 在各构建 profile 中注册同一身份；随声明撤销和插件释放移除。
 * @param ctx - 浏览器根上下文。
 */
export function apply(ctx: ClientContext): void {
  if (document.querySelector('meta[name="agent-assistant-account"][content="enabled"]')) {
    ctx.inject(['theme'], (scope) => {
      const account = new ProductAccount()
      const palette = { getSnapshot: () => scope.theme.getTheme(), subscribe: (listener: () => void) => scope.on('theme/change', listener) }
      scope.effect(() => account.start())
      scope.slots.inject('sidebar.footer.action', () => scope.slots.register({
        name: 'sidebar.footer.action', id: 'product-account', order: -100,
        inject: () => ({ desktop: account.desktop,
          request: <T>(...args: Parameters<typeof account.transport.request>) => account.transport.request<T>(...args),
          logout: () => account.logout(), hooks: { account: account.state, theme: palette } }),
      }, ProductAccountFooter))
    })
  }
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame',
    id: 'pixel-cat',
  }, PixelCat))
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
    name: 'conversation.hero.brand.mark',
  }, GameOperationBrandMark))
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, GameOperationBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', locale: 'sidebar' }, GameOperationBrandName)
    }))
}
