/** 从目标运行目录解析 Office 与指令依赖，不给产品 Host 注入测试插件。 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [root, scratch] = process.argv.slice(2)
assert.ok(root && scratch, 'Pass the target runtime and private fixture directory')
const requireRuntime = createRequire(join(root, 'package.json'))
const load = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Skills } = await load('@deepseek-ai/dsh-skill')
const officeSkills = await load('@deepseek-ai/dsh-skill-office')
const { default: OfficeKit } = await load('@deepseek-ai/dsh-office-kit')
const ctx = new Context()
try {
  await ctx.plugin(Skills).await()
  await ctx.plugin(officeSkills).await()
  await ctx.plugin(OfficeKit, { outputDirectory: join(scratch, 'office-outputs') }).await()
  const names = ['office', 'office-docx', 'office-pptx', 'office-xlsx']
  const listed = new Set((await ctx.skills.list()).map(skill => skill.name))
  const loaded = await Promise.all(names.map(async name => {
    const skill = listed.has(name) ? await ctx.skills.get(name) : undefined
    return { name, bytes: skill?.content.length ?? 0 }
  }))
  assert.ok(loaded.every(skill => skill.bytes > 0), 'Packaged Office instructions must load')
  for (const extension of ['docx', 'xlsx', 'pptx']) {
    const bytes = await readFile(join(scratch, `input.${extension}`))
    const source = operation => ({ key: `desktop-smoke-${operation}-${extension}`, version: 'fixture', bytes: bytes.length,
      async read() { return { bytes, version: 'fixture' } } })
    const pdf = Buffer.from((await ctx.officeKit.convert({ extension, priority: 'foreground', source: source('pdf') })).pdf)
    assert.match(pdf.subarray(0, 8).toString(), /^%PDF-\d\.\d/u)
    assert.ok(pdf.subarray(-1024).toString().trimEnd().endsWith('%%EOF'))
    const rendered = await ctx.officeKit.renderImages({ extension, source: source('images'),
      maxImages: 4, maxPixels: 16_777_216, maxDimension: 8192, maxBytes: 64 * 1024 * 1024 })
    assert.ok(rendered.images.length > 0)
    assert.ok(rendered.images.every(image => Buffer.from(image.png.subarray(0, 8)).toString('hex') === '89504e470d0a1a0a'))
    const format = { docx: 'odt', xlsx: 'ods', pptx: 'odp' }[extension]
    const converted = await ctx.officeKit.convertTo({ extension, format, source: source('convert'),
      output: { owner: 'desktop-smoke', name: `converted.${format}` } })
    assert.equal((await readFile(converted.path)).subarray(0, 4).toString('hex'), '504b0304')
    if (extension === 'xlsx') {
      const recalculated = await ctx.officeKit.recalculate({ extension, format: 'xlsx', source: source('recalculate'),
        output: { owner: 'desktop-smoke', name: 'recalculated.xlsx' } })
      assert.equal((await readFile(recalculated.path)).subarray(0, 4).toString('hex'), '504b0304')
    }
  }
  process.stdout.write(JSON.stringify(loaded))
} finally {
  await ctx.fiber.dispose()
}
