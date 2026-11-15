import { BrandWordmark, CatLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

/** @param props - 宿主要求的尺寸和布局类。 @returns 统一猫头标识。 */
export function GameOperationBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <CatLogo size={size} className={className} />
}

/** @param props - 框架提供的本地化字典。 @returns 不含重复猫头的品牌文字。 */
export function GameOperationBrandName({ t }: PropsLocale<'sidebar'>) {
  return <BrandWordmark label={t('brand.name')} includeMark={false} />
}
