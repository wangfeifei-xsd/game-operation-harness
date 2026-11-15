import { desktopProductDeployment } from './product-deployment.mjs'
/** Resolve the Desktop auto-update channel and its Tencent COS destination. */

import { valid } from 'semver'

/** Environment variable that selects the Desktop update deployment. */
export const DESKTOP_AUTO_UPDATE_ENV = 'DSH_DESKTOP_AUTO_UPDATE_ENV'

/**
 * Resolve the channel embedded in the installer; 首版仅允许 stable.
 * @param {NodeJS.ProcessEnv} env Packaging or upload settings.
 * @returns {'nightly' | 'stable'} Validated channel.
 */
export function resolveDesktopUpdateChannel(env) {
  const channel = env.DSH_DESKTOP_UPDATE_CHANNEL || 'stable'
  if (channel !== 'stable') throw new Error('desktop auto-update: invalid update channel')
  return channel
}

const UPDATE_ENVIRONMENTS = {
  test: {
    bucketEnvName: 'DOWNLOAD_TEST_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_TEST_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_TEST_COS_SECRET_KEY',
  },
  production: {
    bucketEnvName: 'DOWNLOAD_PROD_COS_BUCKET',
    secretIdEnvName: 'DOWNLOAD_PROD_COS_SECRET_ID',
    secretKeyEnvName: 'DOWNLOAD_PROD_COS_SECRET_KEY',
  },
}

const UPDATE_TARGETS = new Set(['mac-arm64', 'mac-x64', 'win-x64'])

/**
 * Name the fixed installer object shared by uploading and cache refresh.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target Supported Desktop target.
 * @returns {string} Fixed download filename.
 */
export function desktopLatestInstallerFilename(target) {
  if (!UPDATE_TARGETS.has(target)) throw new Error(`desktop upload: unsupported target ${target}`)
  const windows = target === 'win-x64'
  return `agent-assistant-latest-${windows ? 'windows' : 'macos'}-${target === 'mac-arm64' ? 'arm64' : 'x64'}.${windows ? 'exe' : 'dmg'}`
}

/**
 * Resolve the production website installer URL shared by approval, upload and purge.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target Supported Desktop target.
 * @returns {string} Fixed production download URL.
 */
export function desktopWebsiteInstallerUrl(target, env = process.env) {
  const config = desktopProductDeployment(env)
  if (config.desktop.downloadIndexUrl === null) throw new Error('尚未配置桌面下载索引')
  return new URL(desktopLatestInstallerFilename(target), config.desktop.downloadIndexUrl).href
}

/**
 * Resolve the update deployment, defaulting local release work to test.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @returns {'test' | 'production'} Validated deployment name.
 */
export function resolveDesktopAutoUpdateEnvironment(env) {
  const config = desktopProductDeployment(env)
  const expected = config.environment === 'master' ? 'production' : 'test'
  const legacy = env[DESKTOP_AUTO_UPDATE_ENV]?.trim()
  if (legacy !== undefined && legacy !== expected) throw new Error('发布存储配置与产品环境不匹配')
  return expected
}

/**
 * Resolve one supported platform and architecture to its update directory.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {'mac-arm64' | 'mac-x64' | 'win-x64'} Update target directory.
 */
export function resolveDesktopAutoUpdateTarget(platform, arch) {
  const os = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : platform
  const target = `${os}-${arch}`
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return target
}

/**
 * Return the local completion record filename for one packaged target.
 * @param {'mac-arm64' | 'mac-x64' | 'win-x64'} target - Supported release target.
 * @returns {string} Filename stored beside electron-builder artifacts.
 */
export function desktopBuildRecordFilename(target) {
  if (!UPDATE_TARGETS.has(target)) {
    throw new Error(`desktop auto-update: unsupported target ${target}`)
  }
  return `${target}-release.json`
}

/**
 * Return the electron-builder channel metadata filename for an application version.
 * @param {string} version - Desktop semantic version.
 * @param {NodeJS.Platform} platform - Target platform.
 * @param {'nightly' | 'stable'} channel - 所选频道；默认 stable.
 * @returns {string} Channel metadata filename emitted for the target.
 */
export function desktopUpdateMetadataFilename(version, platform, channel = 'stable') {
  if (valid(version) === null) {
    throw new Error(`desktop auto-update: invalid Desktop version ${JSON.stringify(version)}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop auto-update: unsupported metadata platform ${platform}`)
  }
  resolveDesktopUpdateChannel({ DSH_DESKTOP_UPDATE_CHANNEL: channel })
  return `${channel}${platform === 'darwin' ? '-mac' : ''}.yml`
}

/**
 * Read one required release setting without accepting whitespace-only values.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {string} name - Environment variable to read.
 * @returns {string} Trimmed setting.
 */
export function requiredEnvironmentValue(env, name) {
  const value = env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop auto-update: ${name} must be set to a non-empty value`)
  }
  return value
}

/**
 * Resolve the public updater URL and object prefixes for one release target.
 * @param {NodeJS.ProcessEnv} env - Packaging or upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', channel: 'nightly' | 'stable', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string }} Resolved updater configuration.
 * @throws {Error} When the test deployment lacks a valid HTTPS origin or a 32-character lowercase hexadecimal release ID.
 */
export function resolveDesktopAutoUpdateConfig(env, platform, arch) {
  const channel = resolveDesktopUpdateChannel(env)
  const environment = resolveDesktopAutoUpdateEnvironment(env)
  const target = resolveDesktopAutoUpdateTarget(platform, arch)
  const config = desktopProductDeployment(env)
  if (!config.desktop.updates.enabled || config.desktop.updates.url === null) throw new Error('所选环境尚未配置桌面普通更新源')
  const base = new URL(config.desktop.updates.url)
  if (!base.pathname.endsWith(`/${config.environment}/${channel}/`)) throw new Error('更新地址必须包含产品环境和频道目录')
  const origin = base.origin
  const releasePrefix = base.pathname.replace(/^\/|\/$/gu, '')
  const keyPrefix = `${releasePrefix}/feeds/${target}`
  return { environment, channel, target, origin, keyPrefix,
    binaryKeyPrefix: `${releasePrefix}/bin/${target}`, publicUrl: `${origin}/${keyPrefix}/` }

}

/**
 * Resolve the public updater URL and private COS destination for one upload target.
 * @param {NodeJS.ProcessEnv} env - Upload environment.
 * @param {NodeJS.Platform} platform - Target Node.js platform.
 * @param {string} arch - Target Node.js architecture.
 * @returns {{ environment: 'test' | 'production', channel: 'nightly' | 'stable', target: 'mac-arm64' | 'mac-x64' | 'win-x64', origin: string, publicUrl: string, keyPrefix: string, binaryKeyPrefix: string, bucket: string, secretIdEnvName: string, secretKeyEnvName: string }} Resolved upload configuration.
 * @throws {Error} When the selected deployment lacks a bucket or valid updater configuration.
 */
export function resolveDesktopUploadConfig(env, platform, arch) {
  const update = resolveDesktopAutoUpdateConfig(env, platform, arch)
  const deployment = UPDATE_ENVIRONMENTS[update.environment]
  return {
    ...update,
    bucket: requiredEnvironmentValue(env, deployment.bucketEnvName),
    secretIdEnvName: deployment.secretIdEnvName,
    secretKeyEnvName: deployment.secretKeyEnvName,
  }
}
