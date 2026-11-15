/** 产品环境文件的选择与账号目录校验。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { HarnessAuthClient } from '../src/harness-auth-client.ts'
import { harnessUserHome, parseHarnessConfig, readHarnessConfig, type HarnessEnvironment } from '../src/harness-config.ts'

function file(environment: HarnessEnvironment): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../../../config/environments/${environment}.json`, import.meta.url), 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('测试配置必须为对象')
  return value as Record<string, unknown>
}

describe('Harness file deployment', () => {
  it('reads an explicit file without accepting environment overrides', () => {
    vi.stubEnv('DSH_HOME', '/external/home')
    vi.stubEnv('DEEPSEEK_BASE_URL', 'https://external.invalid')
    try {
      const config = readHarnessConfig('dev')
      expect(config.environment).toBe('dev')
      expect(config.storage.root).toMatch(/game-operation-harness\/dev$/u)
      expect(config.providers.deepseekBaseUrl).toBe('https://api.deepseek.com/anthropic')
      expect(harnessUserHome(config, 'user_a')).toBe(join(config.storage.root, 'users/user_a'))
      expect(() => harnessUserHome(config, '../other')).toThrow('中央身份标识无效')
    } finally { vi.unstubAllEnvs() }
  })

  it('connects the test environment to its configured remote deployment', async () => {
    const config = readHarnessConfig('test')
    expect(config.creativity.baseUrl).toBe('https://catdev.g-buddy.com')
    expect(config.creativity.deploymentId).toBe('harness-dev')
    expect(config.storage.root).toMatch(/game-operation-harness\/test$/u)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ deployment_id: 'harness-dev' }))
    try {
      const client = new HarnessAuthClient(config)
      await expect(client.bootstrap()).resolves.toBeUndefined()
      expect(fetch.mock.calls[0]?.[0]).toBe('https://catdev.g-buddy.com/api/v1/harness/bootstrap')
      fetch.mockResolvedValueOnce(Response.json({ deployment_id: 'another-deployment' }))
      await expect(client.bootstrap()).rejects.toThrow('认证部署标识不匹配')
    } finally { fetch.mockRestore() }
  })

  it.each(['fat', 'master'] as const)('requires the actual %s service address', (environment) => {
    expect(() => readHarnessConfig(environment)).toThrow('Creativity 地址尚未配置')
    const raw = file(environment)
    const configured = { ...raw, creativity: { baseUrl: 'https://creativity.example', deploymentId: `harness-${environment}`, requestTimeoutMs: 5000 } }
    expect(parseHarnessConfig(configured, environment).environment).toBe(environment)
    expect(() => parseHarnessConfig(configured, 'dev')).toThrow('配置环境不匹配')
  })

  it('rejects missing, unknown and inconsistent configuration', () => {
    expect(() => readHarnessConfig(undefined)).toThrow('请指定 --environment')
    expect(() => readHarnessConfig('production')).toThrow('请指定 --environment')
    expect(() => parseHarnessConfig({ ...file('dev'), extra: true }, 'dev')).toThrow('未声明字段')
    expect(() => parseHarnessConfig({ ...file('dev'), storage: { root: '/tmp/test' } }, 'dev')).toThrow('数据根必须')
    expect(() => parseHarnessConfig({ ...file('dev'), creativity: { baseUrl: 'http://localhost:8000/api', deploymentId: 'harness-master', requestTimeoutMs: 5000 } }, 'dev')).toThrow('根地址或部署标识无效')
    expect(() => parseHarnessConfig({ ...file('test'), creativity: { baseUrl: null, deploymentId: 'harness-dev', requestTimeoutMs: 5000 } }, 'test')).toThrow('Creativity 地址尚未配置')
  })

  it.each(['../deployment', 'deployment with spaces', 'a'.repeat(129)])('rejects invalid deployment identifier %s', (deploymentId) => {
    expect(() => parseHarnessConfig({ ...file('test'), creativity: { baseUrl: 'https://catdev.g-buddy.com', deploymentId, requestTimeoutMs: 5000 } }, 'test')).toThrow('根地址或部署标识无效')
  })
})
