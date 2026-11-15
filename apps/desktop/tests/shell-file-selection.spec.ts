import './product-deployment-fixture.ts'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { Packager, type Configuration, type PlatformSpecificBuildOptions } from 'app-builder-lib'
import { readAsar } from 'app-builder-lib/out/asar/asar.js'
import type { FileMatcher } from 'app-builder-lib/out/fileMatcher.js'
import { getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { MacPackager } from 'app-builder-lib/out/macPackager.js'
import { PM } from 'app-builder-lib/out/node-module-collector/index.js'
import type { PlatformPackager } from 'app-builder-lib/out/platformPackager.js'
import type { ResolvedFileSet } from 'app-builder-lib/out/util/appFileCopier.js'
import { computeFileSets } from 'app-builder-lib/out/util/appFileCopier.js'
import { WinPackager } from 'app-builder-lib/out/winPackager.js'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { desktopTargetBuildPaths } from '../scripts/desktop-build-paths.mjs'

const require = createRequire(import.meta.url)
// The locked builder exports these packaging operations without declarations.
const { getNodeModuleFileMatcher } = require('app-builder-lib/out/fileMatcher.js') as {
  getNodeModuleFileMatcher: (app: string, destination: string, expand: (value: string) => string,
    options: PlatformSpecificBuildOptions, packager: Packager) => FileMatcher
}
const { computeNodeModuleFileSets } = require('app-builder-lib/out/util/appFileCopier.js') as {
  computeNodeModuleFileSets: (packager: PlatformPackager<PlatformSpecificBuildOptions>, matcher: FileMatcher) => Promise<ResolvedFileSet[]>
}
const { AsarPackager } = require('app-builder-lib/out/asar/asarUtil.js') as {
  AsarPackager: new (packager: object, configuration: object) => { pack(files: ResolvedFileSet[]): Promise<void> }
}

it('includes deployment resources and shell runtime chunks through the shipping ASAR copy rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-product-files-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const appDir = join(root, 'app')
  const resources = join(root, 'resources')
  const destination = join(resources, 'app')
  await mkdir(join(appDir, 'product'), { recursive: true })
  await mkdir(resources)
  const descriptor = JSON.stringify({ schemaVersion: 1, environment: 'test', mode: 'local' })
  await writeFile(join(appDir, 'product/deployment.json'), descriptor)
  const runtime = {
    'lib/main.js': 'export const load = () => import("./transport-123.js")\n',
    'lib/transport-123.js': 'export const ready = true\n',
    'lib/operation-report-worker.js': 'export const worker = true\n',
  }
  for (const [name, contents] of Object.entries(runtime)) {
    await mkdir(dirname(join(appDir, name)), { recursive: true })
    await writeFile(join(appDir, name), contents)
  }
  const omitted = ['lib/main.js.map', 'lib/types/main.js']
  for (const name of omitted) {
    await mkdir(dirname(join(appDir, name)), { recursive: true })
    await writeFile(join(appDir, name), 'development output\n')
  }
  const desktop = createElectronBuilderConfig({ DSH_DESKTOP_UNSIGNED: '1' }, 'darwin', 'arm64')
  const product = desktop.files.find(file => typeof file !== 'string' && file.to.startsWith('product') && !file.to.includes('environments'))
  if (product === undefined || typeof product === 'string') throw new Error('missing product resource rule')
  const config: Configuration = { files: [
    ...desktop.files.filter((file): file is string => typeof file === 'string'),
    { from: join(appDir, relative(desktopTargetBuildPaths('mac-arm64').root, product.from)),
      to: product.to, ...(product.filter === undefined ? {} : { filter: [...product.filter] }) },
  ] }
  const info = new Packager({ projectDir: appDir })
  onTestFinished(() => info.tempDirManager.cleanup())
  Object.defineProperties(info, {
    appDir: { value: appDir }, config: { value: config }, metadata: { value: { name: 'fixture', version: '1.0.0' } },
    framework: { value: { name: 'electron' } },
  })
  const packager = new MacPackager(info)
  const matchers = getFileMatchers(config, 'files', destination, { defaultSrc: appDir, globalOutDir: root,
    customBuildOptions: {}, macroExpander: value => value })!
  const fileSets = await computeFileSets(matchers, null, packager, false)
  await new AsarPackager(packager, {
    defaultDestination: destination, resourcePath: resources, options: { smartUnpack: false },
  }).pack(fileSets)
  const archive = await readAsar(join(resources, 'app.asar'))
  expect((await archive.readFile('product/deployment.json')).toString()).toBe(descriptor)
  for (const [name, contents] of Object.entries(runtime)) expect((await archive.readFile(name)).toString()).toBe(contents)
  expect(archive.getNode('lib/main.js.map')).toBeUndefined()
  expect(archive.getNode('lib/types')).toBeUndefined()
})

it.each([
  ['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'],
] as const)('omits shell build files from %s/%s ASAR while retaining runtime assets', async (platform, arch) => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-shell-files-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const appDir = join(root, 'app')
  const resources = join(root, 'resources')
  const destination = join(resources, 'app')
  await mkdir(resources, { recursive: true })
  const manifest = { name: 'fixture', version: '1.0.0', dependencies: { shell: '1.0.0', '@fixture/shared': '2.0.0' } }
  const packages = [
    ['node_modules/shell', { name: 'shell', version: '1.0.0', dependencies: { '@fixture/shared': '1.0.0' } }],
    ['node_modules/@fixture/shared', { name: '@fixture/shared', version: '2.0.0' }],
    ['node_modules/shell/node_modules/@fixture/shared', { name: '@fixture/shared', version: '1.0.0' }],
  ] as const
  const omitted = [
    'index.js.map', 'lib/index.cjs.map', 'lib/index.mjs.map', 'lib/index.ts.map',
    'lib/index.cts.map', 'lib/index.mts.map', 'lib/style.css.map', 'tsconfig.tsbuildinfo', 'lib/types/tsconfig.tsbuildinfo',
  ]
  const retained = [
    'index.js', 'lib/index.cjs', 'lib/index.mjs', 'lib/index.ts', 'lib/index.cts', 'lib/index.mts',
    'lib/style.css', 'lib/types/runtime.js', 'data.map', 'lib/data.map', 'lib/addon.node', 'lib/engine.wasm', 'LICENSE', 'NOTICE',
  ]
  const originals = new Map<string, Buffer>()
  for (const [directory, metadata] of packages) {
    for (const name of [...retained, ...omitted, 'package.json']) {
      const file = join(appDir, directory, name)
      const contents = Buffer.from(name === 'package.json' ? JSON.stringify(metadata) : `${directory}/${name}\n`)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, contents)
      originals.set(file, contents)
    }
  }
  await writeFile(join(appDir, 'package.json'), JSON.stringify(manifest))
  const desktopConfig = createElectronBuilderConfig({
    DSH_DESKTOP_APP_ID: 'com.example.shell-files',
    DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
    DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
    DSH_DESKTOP_UNSIGNED: platform === 'win32' ? '1' : '0',
    DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
    DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
    APPLE_KEYCHAIN_PROFILE: 'shell-files-test',
    DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
    DOWNLOAD_TEST_RELEASE_ID: '0123456789abcdef0123456789abcdef',
  }, platform, arch)
  const config: Configuration = {
    files: desktopConfig.files.map(file => typeof file === 'string' ? file : { from: file.from, to: file.to,
      ...(file.filter === undefined ? {} : { filter: [...file.filter] }) }),
  }
  const info = new Packager({ projectDir: appDir })
  onTestFinished(() => info.tempDirManager.cleanup())
  Object.defineProperties(info, {
    appDir: { value: appDir }, config: { value: config },
    metadata: { value: manifest }, originalMetadata: { value: manifest },
    appInfo: { value: { type: 'commonjs' } },
    framework: { value: { name: 'electron' } },
  })
  // Traverse the installed fixture without invoking a host package manager.
  vi.spyOn(info, 'getPackageManager').mockResolvedValue(PM.TRAVERSAL)
  vi.spyOn(info, 'getWorkspaceRoot').mockResolvedValue(appDir)
  const packager = platform === 'darwin' ? new MacPackager(info) : new WinPackager(info)
  const matcher = getNodeModuleFileMatcher(appDir, destination, value => value, packager.platformSpecificBuildOptions, info)
  const fileSets = await computeNodeModuleFileSets(packager, matcher)
  expect(fileSets.map(set => relative(destination, set.destination).replaceAll('\\', '/')).sort())
    .toEqual(packages.map(([directory]) => directory).sort())
  const consoleLog = console.log
  try {
    await new AsarPackager(packager, {
      defaultDestination: destination, resourcePath: resources, options: { smartUnpack: false },
    }).pack(fileSets)
  } finally {
    // Builder temporarily intercepts console.log while writing ASAR.
    console.log = consoleLog
  }
  const archive = await readAsar(join(resources, 'app.asar'))
  for (const [directory] of packages) {
    for (const name of [...retained, 'package.json']) {
      expect(await archive.readFile(join(directory, name))).toEqual(originals.get(join(appDir, directory, name)))
    }
    for (const name of omitted) expect(archive.getNode(join(directory, name))).toBeUndefined()
  }
  for (const [file, contents] of originals) expect(await readFile(file)).toEqual(contents)
})
