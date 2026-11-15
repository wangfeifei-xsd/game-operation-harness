/** 账号侧栏使用父槽位宽度和框架生成的状态 Hook。 */
import { AccountControls, type AuthTransport, type LocalSession } from '@deepseek-ai/dsh-client-ui-harness-account'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'

/** 仅提供公开状态和当前载体操作。 */
export interface ProductAccountInjected {
  desktop: boolean
  request: AuthTransport['request']
  logout(): Promise<void>
  hooks: { account: HostObservable<LocalSession>; theme: HostObservable<ThemeSnapshot> }
}
type Props = PropsRuntime<'sidebar.footer.action'> & InjectFace<ProductAccountInjected>

/** @param props - 侧栏父数据及账号注入。 @returns 当前账号操作区域。 */
export function ProductAccountFooter({ wide, useAccount, useTheme, desktop, request, logout }: Props) {
  const session = useAccount(value => value)
  const dark = useTheme(value => value.active.colorScheme === 'dark')
  return <AccountControls session={session} wide={wide} dark={dark} desktop={desktop} transport={{ request }} logout={logout} />
}
