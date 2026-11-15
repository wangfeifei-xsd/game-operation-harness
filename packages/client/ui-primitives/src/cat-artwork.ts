/** 连接猫三号母版；界面图标与安装图标生成器共用几何。 */
export const CAT_TRANSFORM = 'translate(-5.32 -7.7) scale(.088)'

/** 标准轮廓，适用于 24 px 及以上。 */
export const CAT_PATH = 'M 873 1005 C 823 1021 781 1025 737 1025 L 478 1025 C 327 1025 214 932 189 824 C 167 735 198 657 254 599 C 233 504 237 399 273 306 C 279 282 293 280 309 289 C 366 317 437 382 486 447 C 578 422 667 423 762 448 C 816 377 891 316 946 287 C 966 276 979 281 985 308 C 1012 400 1021 507 997 596 C 1049 665 1072 723 1065 788 C 1060 863 1022 916 965 952'

/** 小尺寸轮廓，放大开口以适配托盘与运行状态。 */
export const CAT_SMALL_PATH = 'M 853 1010 C 823 1021 781 1025 737 1025 L 478 1025 C 327 1025 214 932 189 824 C 167 735 198 657 254 599 C 233 504 237 399 273 306 C 279 282 293 280 309 289 C 366 317 437 382 486 447 C 578 422 667 423 762 448 C 816 377 891 316 946 287 C 966 276 979 281 985 308 C 1012 400 1021 507 997 596 C 1049 665 1072 723 1065 788 C 1060 863 1022 916 978 938'

/**
 * 输出透明的方形猫头 SVG，供构建脚本栅格化。
 * @param small - 是否采用小尺寸轮廓。
 * @returns 100 单位方形 SVG 文档。
 */
export function catDocument(small = false): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><g transform="${CAT_TRANSFORM}"><path d="${small ? CAT_SMALL_PATH : CAT_PATH}" fill="none" stroke="#315ce8" stroke-width="${small ? 90 : 86}" stroke-linecap="round" stroke-linejoin="round"/><circle cx="462" cy="702" r="61" fill="#315ce8"/><circle cx="788" cy="702" r="61" fill="#315ce8"/></g></svg>`
}
