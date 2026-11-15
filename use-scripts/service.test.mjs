/** 使用隔离项目和真实 HTTP/子进程验证启停脚本，不安装或启动完整应用。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const scripts = dirname(fileURLToPath(import.meta.url))
const output = join(dirname(scripts), 'output')
mkdirSync(output, { recursive: true })

function command(file, args = [], env = {}) {
  const child = spawn('/bin/bash', [file, ...args], { cwd: '/', env: { ...process.env, ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const done = once(child, 'close').then(([code]) => ({ code, stdout, stderr }))
  return { child, done }
}

async function until(condition) {
  const deadline = Date.now() + 10000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待脚本状态超时。')
    await delay(50)
  }
}

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function fixture(context) {
  const temporary = mkdtempSync(join(output, 'script-smoke-'))
  const root = join(temporary, '项目 有空格')
  const bin = join(root, 'bin')
  const port = await freePort()
  mkdirSync(join(root, 'use-scripts'), { recursive: true })
  mkdirSync(bin)
  for (const file of ['start.sh', 'stop.sh', 'start.command', 'stop.command', 'service.mjs']) {
    copyFileSync(join(scripts, file), join(root, 'use-scripts', file))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', engines: { node: '>=24.9.0' }, packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture-lock')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'fixture-workspace')
  // 复用真实配置校验器及其源码依赖，避免替身放过无效部署配置。
  mkdirSync(join(root, 'apps', 'cli', 'src'), { recursive: true })
  copyFileSync(join(dirname(scripts), 'apps', 'cli', 'src', 'harness-config.ts'), join(root, 'apps', 'cli', 'src', 'harness-config.ts'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(join(dirname(scripts), 'node_modules', 'tsx'), join(root, 'node_modules', 'tsx'), 'dir')
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    paths: { '@deepseek-ai/dsh-home-paths': [join(dirname(scripts), 'packages', 'util', 'home-paths', 'src', 'index.ts')] },
  } }))
  const directory = join(root, 'config', 'environments')
  mkdirSync(directory, { recursive: true })
  const template = JSON.parse(readFileSync(join(dirname(scripts), 'config', 'environments', 'dev.json'), 'utf8'))
  for (const environment of ['dev', 'test', 'fat', 'master']) {
    writeFileSync(join(directory, `${environment}.json`), JSON.stringify({
      ...template, environment, server: { host: '127.0.0.1', port },
      creativity: { ...template.creativity, deploymentId: `harness-${environment}` },
      storage: { root: join(root, 'data', environment) },
    }))
  }
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { parseArgs } from 'node:util'
const args = process.argv.slice(2)
if (args[0] === '--version') console.log('11.28.5')
else if (args[0] === 'install') {
  if (process.env.FIXTURE_SLOW === '1') {
    writeFileSync('install.pid', String(process.pid))
    setInterval(() => {}, 1000)
  } else {
    mkdirSync('node_modules', { recursive: true })
    writeFileSync('node_modules/.modules.yaml', 'fixture')
    appendFileSync('installs', 'installed\\n')
  }
} else if (args[0] === 'run' && args[1] === 'dev:web') {
  const { values } = parseArgs({ args: args.slice(2), options: {
    environment: { type: 'string' }, 'no-open': { type: 'boolean' },
  } })
  if (!['dev', 'test', 'fat', 'master'].includes(values.environment)) process.exit(9)
  writeFileSync('launch.json', JSON.stringify(values))
  if (process.env.FIXTURE_FAIL === '1') {
    console.error('构建失败测试')
    process.exit(7)
  }
  const { server } = JSON.parse(readFileSync('config/environments/' + values.environment + '.json', 'utf8'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync('descendant.pid', String(child.pid))
  createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (url.pathname === '/harness/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('fixture login')
    } else {
      response.writeHead(401)
      response.end('unauthorized')
    }
  }).listen(server.port, server.host, () => {
    const host = server.host === '::1' ? '[::1]' : server.host
    console.log('Harness: http://' + host + ':' + server.port + '/')
  })
} else process.exit(9)
`, { mode: 0o755 })
  const env = { PATH: `${bin}:${process.env.PATH}` }
  const recordPath = join(root, 'output', 'local-service', 'service.json')
  const run = (action, args = [], extra = {}) => command(join(root, 'use-scripts', action), args, { ...env, ...extra })
  context.after(async () => {
    await run('stop.sh').done
    rmSync(temporary, { recursive: true, force: true })
  })
  return { root, recordPath, port, run }
}

test('支持中文空格路径、重复启停、依赖复用，并关闭服务子进程', { timeout: 30000 }, async context => {
  const { root, recordPath, port, run } = await fixture(context)
  const started = await run('start.command', ['--no-open']).done
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, /启动成功/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/harness/login`)).text(), 'fixture login')
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8')), { environment: 'dev', 'no-open': true })
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const descendant = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'))
  const duplicate = await run('start.sh', ['--no-open']).done
  assert.equal(duplicate.code, 0, duplicate.stderr)
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).pid, record.pid)
  const stopped = await run('stop.command').done
  assert.equal(stopped.code, 0, stopped.stderr)
  await until(() => !isAlive(record.pid) && !isAlive(descendant))
  assert.equal(existsSync(recordPath), false)
  assert.equal((await run('stop.sh').done).code, 0)
  assert.equal((await run('start.sh', ['--no-open']).done).code, 0)
  assert.equal(readFileSync(join(root, 'installs'), 'utf8').trim(), 'installed')
  assert.equal((await run('stop.sh').done).code, 0)
})

test('端口占用时拒绝启动并保留原服务', { timeout: 15000 }, async context => {
  const { port, run } = await fixture(context)
  const server = createServer((request, response) => response.end('existing'))
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise(resolve => server.close(resolve)))
  const result = await run('start.sh').done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /server.port/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing')
})

test('通过公开登录页确认就绪，不把未登录的 401 当作失败', { timeout: 15000 }, async context => {
  const { port, run } = await fixture(context)
  const started = await run('start.sh', ['--no-open']).done
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, new RegExp(`启动成功：http://127\\.0\\.0\\.1:${port}/harness/login`))
  const response = await fetch(`http://127.0.0.1:${port}`)
  assert.equal(response.status, 401)
  await response.body.cancel()
  assert.equal((await run('start.sh', ['--no-open']).done).code, 0)
})

test('损坏或复用的运行 PID 不会关闭无关进程', { timeout: 15000 }, async context => {
  const { recordPath, run } = await fixture(context)
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify({ pid: process.pid, token: 'stale-token', port: 3080 }))
  const result = await run('stop.sh').done
  assert.equal(result.code, 0, result.stderr)
  assert.equal(isAlive(process.pid), true)
  assert.equal(existsSync(recordPath), false)
  writeFileSync(recordPath, '{invalid-json')
  const invalid = await run('stop.sh').done
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, /无法读取运行记录/)
  rmSync(recordPath)
})

test('安装期间可以关闭，取消的安装不会留下成功标记', { timeout: 20000 }, async context => {
  const { root, recordPath, run } = await fixture(context)
  const started = run('start.sh', ['--no-open'], { FIXTURE_SLOW: '1' })
  await until(() => existsSync(join(root, 'install.pid')))
  const installer = Number(readFileSync(join(root, 'install.pid'), 'utf8'))
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const result = await run('stop.sh').done
  assert.equal(result.code, 0, result.stderr)
  assert.equal((await started.done).code, 1)
  await until(() => !isAlive(installer) && !isAlive(record.pid))
  assert.equal(existsSync(join(dirname(recordPath), 'dependencies.sha256')), false)
})

test('构建失败会报告失败并保留日志，修复后可重试', { timeout: 20000 }, async context => {
  const { root, run } = await fixture(context)
  const failed = await run('start.sh', ['--no-open'], { FIXTURE_FAIL: '1' }).done
  assert.equal(failed.code, 1)
  assert.match(readFileSync(join(root, 'output', 'local-service', 'web.log'), 'utf8'), /构建失败测试/)
  const retried = await run('start.sh', ['--no-open']).done
  assert.equal(retried.code, 0, retried.stderr)
})

test('端口参数提示改用部署文件，未知环境直接失败', { timeout: 10000 }, async context => {
  const { root, run } = await fixture(context)
  const result = await run('start.sh', ['--port', '3081']).done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /server.port/)
  const invalid = await run('start.sh', ['--environment', 'unknown']).done
  assert.equal(invalid.code, 1)
  assert.match(invalid.stderr, /dev.*test.*fat.*master/)
  assert.equal(existsSync(join(root, 'installs')), false)
})

test('显式选择部署环境，拒绝复用另一个环境的服务', { timeout: 15000 }, async context => {
  const { root, recordPath, run } = await fixture(context)
  const started = await run('start.sh', ['--environment', 'test', '--no-open']).done
  assert.equal(started.code, 0, started.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'launch.json'), 'utf8')), { environment: 'test', 'no-open': true })
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(record.environment, 'test')
  const different = await run('start.sh', ['--no-open']).done
  assert.equal(different.code, 1)
  assert.match(different.stderr, /stop.sh/)
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).pid, record.pid)
})

test('部署配置无效时在构建前失败，保留具体原因', { timeout: 15000 }, async context => {
  const { root, run } = await fixture(context)
  const configPath = join(root, 'config', 'environments', 'test.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.creativity.baseUrl = null
  writeFileSync(configPath, JSON.stringify(config))
  const result = await run('start.sh', ['--environment', 'test', '--no-open']).done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /test 的 Creativity 地址尚未配置/)
  assert.equal(existsSync(join(root, 'launch.json')), false)
})
