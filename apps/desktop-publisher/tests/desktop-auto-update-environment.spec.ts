import '../../desktop/tests/product-deployment-fixture.ts'
import { expect, it } from 'vitest'
import {
  desktopBuildRecordFilename, desktopWebsiteInstallerUrl, desktopUpdateMetadataFilename,
  resolveDesktopAutoUpdateConfig, resolveDesktopAutoUpdateEnvironment, resolveDesktopAutoUpdateTarget, resolveDesktopUploadConfig,
} from '../src/desktop-auto-update-environment.mjs'

it.each(['dev', 'test', 'fat', 'master'])('resolves the controlled %s deployment and matching storage preset', (environment) => {
  const env = { DSH_DESKTOP_PRODUCT_ENVIRONMENT: environment }
  expect(resolveDesktopAutoUpdateEnvironment(env)).toBe(environment === 'master' ? 'production' : 'test')
  const config = resolveDesktopAutoUpdateConfig(env, 'win32', 'x64')
  expect(config).toMatchObject({ channel: 'stable', target: 'win-x64',
    publicUrl: `https://updates.example.com/agent-assistant/${environment}/stable/feeds/win-x64/`,
    binaryKeyPrefix: `agent-assistant/${environment}/stable/bin/win-x64` })
  expect(() => resolveDesktopAutoUpdateConfig({ ...env, DSH_DESKTOP_AUTO_UPDATE_ENV: environment === 'master' ? 'test' : 'production' }, 'win32', 'x64')).toThrow(/不匹配/u)
})

it('ignores legacy network overrides and requires credentials only for the selected storage', () => {
  const env = { DOWNLOAD_TEST_ORIGIN: 'https://foreign.example', DOWNLOAD_TEST_RELEASE_ID: '../escape' }
  expect(resolveDesktopAutoUpdateConfig(env, 'darwin', 'arm64').origin).toBe('https://updates.example.com')
  expect(() => resolveDesktopUploadConfig(env, 'darwin', 'arm64')).toThrow(/DOWNLOAD_TEST_COS_BUCKET/u)
  expect(resolveDesktopUploadConfig({ ...env, DOWNLOAD_TEST_COS_BUCKET: 'fixture-bucket' }, 'darwin', 'arm64')).toMatchObject({
    bucket: 'fixture-bucket', secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID', secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY' })
})

it.each([['darwin', 'arm64', 'mac-arm64'], ['darwin', 'x64', 'mac-x64'], ['win32', 'x64', 'win-x64']] as const)
('uses the selected environment for %s %s updates and downloads', (platform, arch, target) => {
  const env = { DSH_DESKTOP_PRODUCT_ENVIRONMENT: 'master' }
  const config = resolveDesktopAutoUpdateConfig(env, platform, arch)
  expect(config.keyPrefix).toBe(`agent-assistant/master/stable/feeds/${target}`)
  expect(desktopWebsiteInstallerUrl(target, env)).toBe(`https://updates.example.com/agent-assistant/master/stable/agent-assistant-latest-${platform === 'darwin' ? 'macos' : 'windows'}-${arch}.${platform === 'darwin' ? 'dmg' : 'exe'}`)
  expect(desktopUpdateMetadataFilename('1.0.0-rc.1', platform)).toBe(platform === 'darwin' ? 'stable-mac.yml' : 'stable.yml')
})

it('rejects unsupported environments, targets and unpublished channels', () => {
  expect(() => resolveDesktopAutoUpdateEnvironment({ DSH_DESKTOP_PRODUCT_ENVIRONMENT: 'production' })).toThrow()
  expect(() => resolveDesktopAutoUpdateTarget('linux', 'x64')).toThrow(/unsupported target/u)
  expect(() => desktopBuildRecordFilename('linux-x64' as 'mac-arm64')).toThrow(/unsupported target/u)
  expect(() => resolveDesktopAutoUpdateConfig({ DSH_DESKTOP_UPDATE_CHANNEL: 'nightly' }, 'win32', 'x64')).toThrow(/channel/u)
  expect(() => desktopUpdateMetadataFilename('invalid', 'darwin')).toThrow(/invalid Desktop version/u)
})
