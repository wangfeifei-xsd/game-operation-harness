import type { IconProps } from './icons/props.ts'
import { CatLogo } from './CatLogo.tsx'
import css from './BrandWordmark.module.css'

/** 使用宿主提供的本地化产品名，图标和文字可以独立占据品牌槽位。 */
export interface BrandWordmarkProps extends IconProps {
  /** 本地化产品名称，由界面字典提供。 */
  label: string
  /** 是否包含猫头；独立图标槽位的消费者传 false。 */
  includeMark?: boolean | undefined
}

/**
 * 以公共猫头和主题字体排版品牌名，不压缩字形。
 * @param props - 本地化名称、高度、布局类及是否包含猫头。
 * @returns 装饰性字标；可访问名称由交互宿主提供。
 */
export function BrandWordmark({ label, size = 24, className, includeMark = true }: BrandWordmarkProps) {
  return (
    <span className={`${css.wordmark} ${className ?? ''}`} style={{ height: size, fontSize: size * 0.625 }} aria-hidden="true" data-brand-wordmark="" data-brand-wide={label.length > 20 || undefined}>
      {includeMark && <CatLogo size={size} />}
      <span>{label}</span>
    </span>
  )
}
