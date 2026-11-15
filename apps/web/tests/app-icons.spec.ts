/** 验证生成尺寸、平台安全区模板与非法源文档处理。 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ICON_VARIANTS, ICON_OUTPUT_DIRECTORY, TILE_SOURCE, maskableDocument, tileDocument } from '../scripts/render-app-icons.ts'
import { pngSize } from './png-size.ts'

describe('web install icons', () => {
  it('ships every declared variant at its declared edge', async () => {
    for (const variant of APP_ICON_VARIANTS) {
      expect(pngSize(await readFile(join(ICON_OUTPUT_DIRECTORY, variant.file)))).toEqual([variant.size, variant.size])
    }
  })

  it('retains the complete cat master in opaque platform templates', () => {
    for (const document of [tileDocument(TILE_SOURCE), maskableDocument(TILE_SOURCE)]) {
      expect(document).toContain(TILE_SOURCE)
      expect(document).toContain('<rect width="100" height="100" fill="#eef3ff"/>')
      expect(document).not.toContain('filter0_d_')
    }
    expect(tileDocument(TILE_SOURCE)).not.toBe(maskableDocument(TILE_SOURCE))
  })

  it('rejects non-PNG bytes and incomplete image headers', () => {
    expect(() => pngSize(Buffer.from('<svg/>'))).toThrow(/PNG IHDR/)
    expect(() => pngSize(Buffer.alloc(33))).toThrow(/PNG IHDR/)
  })

  it('rejects documents that cannot supply the expected square master', () => {
    for (const source of ['', '<svg></svg>', '<svg viewBox="0 0 200 100"></svg>']) {
      expect(() => tileDocument(source)).toThrow(/100-unit SVG master/)
    }
  })
})
