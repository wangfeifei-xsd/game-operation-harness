/** Harness 文件部署配置；不读取 .env、进程变量或当前工作目录。 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, resolve, join } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

/** 支持的独立部署文件名。 */
export type HarnessEnvironment = 'dev' | 'test' | 'fat' | 'master'
/** Node 内部持有的部署配置，不向浏览器公开。 */
export interface HarnessConfig {
  environment: HarnessEnvironment
  server: { host: string; port: number }
  creativity: { baseUrl: string; deploymentId: string; requestTimeoutMs: number }
  auth: { heartbeatIntervalMs: number; shutdownGraceMs: number }
  storage: { root: string }
  proxy: { http: string | null; https: string | null; noProxy: string }
  providers: { deepseekBaseUrl: string; accountBaseUrl: string; searchBaseUrl: string; credentials: Record<string, string> }
  telemetry: { enabled: boolean; mode: 'DISABLED' | 'FEEDBACK_ONLY'; url: string }
  sandbox: { mode: 'workspace-write' | 'read-only' | 'danger-full-access'; approval: 'ask' | 'never' }
}

function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || keys.some(key => !(key in value)) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new Error('Harness 配置字段缺失或存在未声明字段')
  }
}
function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Harness 配置字符串不能为空')
}
function integer(value: unknown, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Harness 配置数值超出范围')
}
function url(value: unknown): asserts value is string {
  string(value)
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Harness 配置地址无效')
}

/**
 * 校验一份完整文件并规范化环境数据目录。
 * @param raw - JSON 文件内容。
 * @param environment - 显式选择的环境。
 * @returns 经过校验的部署配置。
 */
export function parseHarnessConfig(raw: unknown, environment: HarnessEnvironment): HarnessConfig {
  object(raw, ['environment','server','creativity','auth','storage','proxy','providers','telemetry','sandbox'])
  if (raw.environment !== environment) throw new Error('Harness 配置环境不匹配')
  const { server, creativity, auth, storage, proxy, providers, telemetry, sandbox } = raw
  object(server, ['host','port']); string(server.host); integer(server.port, 1, 65535)
  if (!['127.0.0.1','::1'].includes(server.host)) throw new Error('一期 Harness 入口只允许监听 loopback')
  object(creativity, ['baseUrl','deploymentId','requestTimeoutMs'])
  if (creativity.baseUrl === null) throw new Error(`${environment} 的 Creativity 地址尚未配置`)
  url(creativity.baseUrl); string(creativity.deploymentId); integer(creativity.requestTimeoutMs, 1, 5000)
  if (new URL(creativity.baseUrl).pathname !== '/' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(creativity.deploymentId)) throw new Error('Creativity 根地址或部署标识无效')
  object(auth, ['heartbeatIntervalMs','shutdownGraceMs']); integer(auth.heartbeatIntervalMs, 1, 10000); integer(auth.shutdownGraceMs, 1, 5000)
  object(storage, ['root']); string(storage.root)
  const root = resolve(expandHomePath(storage.root))
  if (basename(root) !== environment) throw new Error('Harness 数据根必须以所选环境名称结尾')
  object(proxy, ['http','https','noProxy']); string(proxy.noProxy)
  for (const value of [proxy.http,proxy.https]) if (value !== null) url(value)
  if (proxy.http !== null && typeof proxy.http !== 'string' || proxy.https !== null && typeof proxy.https !== 'string') throw new Error('代理地址无效')
  object(providers, ['deepseekBaseUrl','accountBaseUrl','searchBaseUrl','credentials'])
  url(providers.deepseekBaseUrl); url(providers.accountBaseUrl); url(providers.searchBaseUrl)
  if (typeof providers.credentials !== 'object' || providers.credentials === null || Array.isArray(providers.credentials)) throw new Error('供应商凭据配置无效')
  const credentials: Record<string,string> = {}
  for (const [key,value] of Object.entries(providers.credentials)) { string(value); credentials[key] = value }
  object(telemetry, ['enabled','mode','url']); url(telemetry.url)
  if (typeof telemetry.enabled !== 'boolean' || !['DISABLED','FEEDBACK_ONLY'].includes(String(telemetry.mode))) throw new Error('遥测配置无效')
  object(sandbox, ['mode','approval'])
  if (!['workspace-write','read-only','danger-full-access'].includes(String(sandbox.mode)) || !['ask','never'].includes(String(sandbox.approval))) throw new Error('沙箱配置无效')
  return {
    environment, server: { host:server.host,port:server.port },
    creativity: { baseUrl:creativity.baseUrl,deploymentId:creativity.deploymentId,requestTimeoutMs:creativity.requestTimeoutMs },
    auth: { heartbeatIntervalMs:auth.heartbeatIntervalMs,shutdownGraceMs:auth.shutdownGraceMs }, storage:{ root },
    proxy:{ http:proxy.http,https:proxy.https,noProxy:proxy.noProxy },
    providers:{ deepseekBaseUrl:providers.deepseekBaseUrl,accountBaseUrl:providers.accountBaseUrl,
      searchBaseUrl:providers.searchBaseUrl,credentials },
    telemetry:{ enabled:telemetry.enabled,mode:telemetry.mode as HarnessConfig['telemetry']['mode'],url:telemetry.url },
    sandbox:{ mode:sandbox.mode as HarnessConfig['sandbox']['mode'],approval:sandbox.approval as HarnessConfig['sandbox']['approval'] },
  }
}

/**
 * 从安装资源目录选择并读取一份配置。
 * @param environment - 命令行显式环境名。
 * @returns 已校验配置；缺失地址等错误直接阻止启动。
 */
export function readHarnessConfig(environment: string | undefined): HarnessConfig {
  if (!['dev','test','fat','master'].includes(environment ?? '')) throw new Error('请指定 --environment dev|test|fat|master')
  const selected = environment as HarnessEnvironment
  const source = new URL('../../../config/environments/', import.meta.url)
  const directory = existsSync(source) ? fileURLToPath(source) : fileURLToPath(new URL('./resources/environments/', import.meta.url))
  return parseHarnessConfig(JSON.parse(readFileSync(join(directory, `${selected}.json`), 'utf8')), selected)
}

/**
 * 中央身份构造账号目录，拒绝路径分隔符、点目录与伪造标识。
 * @param config - 已验证的环境配置。
 * @param user - 中央返回的用户。
 * @returns 用户运行目录。
 */
export function harnessUserHome(config: HarnessConfig, user: string): string {
  if (![user].every(value => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value))) throw new Error('中央身份标识无效')
  return join(config.storage.root, 'users', user)
}
