import type { IconProps } from './icons/props.ts'
import { CAT_PATH, CAT_SMALL_PATH, CAT_TRANSFORM } from './cat-artwork.ts'

/**
 * 渲染连接猫；20 px 及以下采用加粗、扩大开口的小尺寸母版。
 * @param props - 方形边长及宿主布局类名；颜色继承 currentColor。
 * @returns 装饰性 SVG，可访问名称由宿主提供。
 */
export function CatLogo({ size = 24, className }: IconProps) {
  const small = size <= 20
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 100 100" fill="none" aria-hidden="true" data-brand-cat="">
      <g transform={CAT_TRANSFORM}>
        <path d={small ? CAT_SMALL_PATH : CAT_PATH} stroke="currentColor" strokeWidth={small ? 90 : 86} strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="462" cy="702" r="61" fill="currentColor" />
        <circle cx="788" cy="702" r="61" fill="currentColor" />
      </g>
    </svg>
  )
}
