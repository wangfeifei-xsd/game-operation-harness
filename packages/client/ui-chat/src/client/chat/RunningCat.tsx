/** 运行状态采用透明 APNG；减少动态效果或不支持遮罩时使用公共静态猫头。 */
import { CatLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ChatView.module.css'

/** @returns 装饰性运行图标，实际状态由相邻本地化文字表达。 */
export function RunningCat() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <span className={css.runningCatAnimated} />
      <CatLogo size={16} className={css.runningCatStill} />
    </span>
  )
}
