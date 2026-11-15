/** 目录升级保留账号数据，冲突、占用及异常路径均不产生空白替代目录。 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { harnessUserHome, readHarnessConfig, type HarnessConfig } from '../src/harness-config.ts'
import { migrateHarnessUserHome } from '../src/harness-home.ts'

let root: string
let config: HarnessConfig
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-home-'))
  config = { ...readHarnessConfig('dev'), storage: { root: join(root, 'dev') } }
  mkdirSync(join(config.storage.root, 'users'), { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function seed(channel: string, user = 'user_a'): string {
  const path = join(config.storage.root, 'users', channel, user)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'history.jsonl'), '账号原有记录\n')
  return path
}

function prepare(user = 'user_a'): string {
  const home = harnessUserHome(config, user)
  const release = lockfile.lockSync(home, { realpath: false })
  try { migrateHarnessUserHome(config, user) }
  finally { release() }
  return home
}

it('moves the sole legacy home and retains data across later logins', () => {
  const old = seed('channel_harness')
  seed('other_channel', 'user_b')
  const home = prepare()
  expect(existsSync(old)).toBe(false)
  expect(readFileSync(join(home, 'history.jsonl'), 'utf8')).toBe('账号原有记录\n')
  expect(prepare()).toBe(home)
  expect(readFileSync(join(home, 'history.jsonl'), 'utf8')).toBe('账号原有记录\n')
  expect(existsSync(join(config.storage.root, 'users/other_channel/user_b/history.jsonl'))).toBe(true)
})

it('creates a home for a new account without borrowing another user history', () => {
  seed('channel_harness', 'user_b')
  expect(existsSync(join(prepare(), 'history.jsonl'))).toBe(false)
})

it.each(['two-sources', 'existing-destination'] as const)('preserves all data on %s conflicts', (kind) => {
  const old = seed('channel_harness')
  if (kind === 'two-sources') seed('another_channel')
  else mkdirSync(harnessUserHome(config, 'user_a'))
  expect(prepare).toThrow(expect.objectContaining({ code: 'HARNESS_HOME_CONFLICT' }))
  expect(readFileSync(join(old, 'history.jsonl'), 'utf8')).toBe('账号原有记录\n')
})

it('refuses a legacy home held by an older instance and succeeds once it stops', () => {
  const old = seed('channel_harness')
  const release = lockfile.lockSync(old)
  try {
    expect(prepare).toThrow(expect.objectContaining({ code: 'HARNESS_HOME_IN_USE' }))
    expect(existsSync(harnessUserHome(config, 'user_a'))).toBe(false)
    expect(existsSync(old)).toBe(true)
  } finally { release() }
  expect(existsSync(join(prepare(), 'history.jsonl'))).toBe(true)
})

it.each(['channel', 'source', 'destination', 'parent'] as const)('rejects a symbolic %s path without touching its target', (kind) => {
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'retained'), '保留')
  const parent = join(config.storage.root, 'users')
  if (kind === 'channel') {
    mkdirSync(join(outside, 'user_a'))
    symlinkSync(outside, join(parent, 'channel_harness'), 'junction')
  } else if (kind === 'source') {
    mkdirSync(join(parent, 'channel_harness'))
    symlinkSync(outside, join(parent, 'channel_harness/user_a'), 'junction')
  } else if (kind === 'destination') symlinkSync(outside, join(parent, 'user_a'), 'junction')
  else {
    rmSync(parent, { recursive: true })
    symlinkSync(outside, parent, 'junction')
  }
  expect(prepare).toThrow(expect.objectContaining({ code: 'HARNESS_HOME_INVALID' }))
  expect(readFileSync(join(outside, 'retained'), 'utf8')).toBe('保留')
})
