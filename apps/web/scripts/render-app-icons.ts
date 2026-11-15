/** 从连接猫公共母版生成 PWA 与 Apple touch 图标；各平台模板显式定义安全区。 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catDocument } from '@deepseek-ai/dsh-client-ui-primitives/src/cat-artwork.ts'

/** 透明 SVG 母版，与运行时 CatLogo 共用几何。 */
export const TILE_SOURCE = catDocument()
/** 提交到仓库的安装图标目录。 */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))
/** 遮罩版相对普通图标的缩放比例。 */
export const MASKABLE_ARTWORK_SCALE = 60 / 64
/** 平台保证保留的中心安全圆半径比例。 */
export const MASKABLE_SAFE_RADIUS_RATIO = 0.4

/** 安装图标的尺寸和平台模板。 */
export interface AppIconVariant {
  /** public 目录中的文件名。 */
  readonly file: string
  /** 输出方形边长，单位 px。 */
  readonly size: number
  /** 普通满底模板或遮罩安全区模板。 */
  readonly kind: 'tile' | 'maskable'
}

/** 浏览器安装与 iOS 主屏幕所需的完整图标组。 */
export const APP_ICON_VARIANTS: readonly AppIconVariant[] = [
  { file: 'icon-192.png', size: 192, kind: 'tile' },
  { file: 'icon-512.png', size: 512, kind: 'tile' },
  { file: 'icon-maskable-512.png', size: 512, kind: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, kind: 'tile' },
]

function template(source: string, extent: number): string {
  if (!/^<svg\s[^>]*viewBox="0 0 100 100"/u.test(source.trim())) {
    throw new Error('app icons: expected a square 100-unit SVG master')
  }
  const offset = (100 - extent) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="#eef3ff"/><g id="cat-glyph" transform="translate(${offset} ${offset}) scale(${extent / 100})">${source}</g></svg>`
}

/** @param source - 透明猫头 SVG。 @returns 带不透明满底的普通安装模板。 */
export function tileDocument(source: string): string {
  return template(source, 64)
}

/** @param source - 透明猫头 SVG。 @returns 图形完全位于安全圆内的满底模板。 */
export function maskableDocument(source: string): string {
  return template(source, 60)
}

/**
 * 先高分辨率渲染再降采样，保留小图标曲线的抗锯齿。
 * @param source - 共用的透明 SVG 母版。
 * @returns 与清单同序的 PNG 图标。
 */
export async function renderAppIcons(source: string): Promise<readonly { variant: AppIconVariant; png: Buffer }[]> {
  const { default: sharp } = await import('sharp')
  return Promise.all(APP_ICON_VARIANTS.map(async (variant) => {
    const document = variant.kind === 'maskable' ? maskableDocument(source) : tileDocument(source)
    const raster = await sharp(Buffer.from(document), { density: 72 * variant.size * 4 / 100 }).png().toBuffer()
    const png = await sharp(raster).resize(variant.size, variant.size, { kernel: 'lanczos3' }).png().toBuffer()
    return { variant, png }
  }))
}

async function main(): Promise<void> {
  const icons = await renderAppIcons(TILE_SOURCE)
  await Promise.all(icons.map(({ variant, png }) => writeFile(resolve(ICON_OUTPUT_DIRECTORY, variant.file), png)))
  console.info(`app icons: wrote ${icons.map(icon => icon.variant.file).join(', ')}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
