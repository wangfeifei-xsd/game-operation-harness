/** 使用隔离项目和真实 HTTP/子进程验证启停脚本，不安装或启动完整应用。 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function fixture(context) {
  const temporary = mkdtempSync(join(output, 'script-smoke-'))
  const root = join(temporary, '项目 有空格')
  const bin = join(root, 'bin')
  mkdirSync(join(root, 'use-scripts'), { recursive: true })
  mkdirSync(bin)
  for (const file of ['start.sh', 'stop.sh', 'start.command', 'stop.command', 'service.mjs']) {
    copyFileSync(join(scripts, file), join(root, 'use-scripts', file))
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: '>=24.9.0' }, packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'fixture-lock')
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'fixture-workspace')
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
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
  if (process.env.FIXTURE_FAIL === '1') {
    console.error('构建失败测试')
    process.exit(7)
  }
  const port = Number(args[args.indexOf('--port') + 1])
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  writeFileSync('descendant.pid', String(child.pid))
  const authenticated = process.env.FIXTURE_AUTH === '1'
  createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    if (authenticated && url.searchParams.get('token') === 'fixture-token') {
      response.writeHead(303, { 'set-cookie': 'fixture=session; Path=/; HttpOnly', location: '/' })
      response.end()
    } else if (authenticated && request.headers.cookie !== 'fixture=session') {
      response.writeHead(401)
      response.end('unauthorized')
    } else response.end('fixture web')
  }).listen(port, '127.0.0.1', () => {
    console.log('dsh web: http://127.0.0.1:' + port + '/' + (authenticated ? '?token=fixture-token' : ''))
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
  return { root, recordPath, run }
}

test('支持中文空格路径、重复启停、依赖复用，并关闭服务子进程', { timeout: 30000 }, async context => {
  const { root, recordPath, run } = fixture(context)
  const port = await freePort()
  const started = await run('start.command', ['--port', String(port), '--no-open']).done
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, /启动成功/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'fixture web')
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const descendant = Number(readFileSync(join(root, 'descendant.pid'), 'utf8'))
  const duplicate = await run('start.sh', ['--port', String(port), '--no-open']).done
  assert.equal(duplicate.code, 0, duplicate.stderr)
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).pid, record.pid)
  const stopped = await run('stop.command').done
  assert.equal(stopped.code, 0, stopped.stderr)
  await until(() => !isAlive(record.pid) && !isAlive(descendant))
  assert.equal(existsSync(recordPath), false)
  assert.equal((await run('stop.sh').done).code, 0)
  assert.equal((await run('start.sh', ['--port', String(port), '--no-open']).done).code, 0)
  assert.equal(readFileSync(join(root, 'installs'), 'utf8').trim(), 'installed')
  assert.equal((await run('stop.sh').done).code, 0)
})

test('端口占用时拒绝启动并保留原服务', { timeout: 15000 }, async context => {
  const { run } = fixture(context)
  const server = createServer((request, response) => response.end('existing'))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => new Promise(resolve => server.close(resolve)))
  const { port } = server.address()
  const result = await run('start.sh', ['--port', String(port)]).done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /--port/)
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'existing')
})

test('通过应用认证入口确认就绪，并打印可直接使用的访问链接', { timeout: 15000 }, async context => {
  const { run } = fixture(context)
  const port = await freePort()
  const started = await run('start.sh', ['--port', String(port), '--no-open'], { FIXTURE_AUTH: '1' }).done
  assert.equal(started.code, 0, started.stderr)
  assert.match(started.stdout, /启动成功：http:\/\/127\.0\.0\.1:\d+\/\?token=fixture-token/)
  const response = await fetch(`http://127.0.0.1:${port}`)
  assert.equal(response.status, 401)
  await response.body.cancel()
  assert.equal((await run('start.sh', ['--port', String(port), '--no-open']).done).code, 0)
})

test('损坏或复用的运行 PID 不会关闭无关进程', { timeout: 15000 }, async context => {
  const { recordPath, run } = fixture(context)
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
  const { root, recordPath, run } = fixture(context)
  const port = await freePort()
  const started = run('start.sh', ['--port', String(port), '--no-open'], { FIXTURE_SLOW: '1' })
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
  const { root, run } = fixture(context)
  const port = await freePort()
  const failed = await run('start.sh', ['--port', String(port), '--no-open'], { FIXTURE_FAIL: '1' }).done
  assert.equal(failed.code, 1)
  assert.match(readFileSync(join(root, 'output', 'local-service', 'web.log'), 'utf8'), /构建失败测试/)
  const retried = await run('start.sh', ['--port', String(port), '--no-open']).done
  assert.equal(retried.code, 0, retried.stderr)
})

test('无效端口直接失败', { timeout: 10000 }, async context => {
  const { run } = fixture(context)
  const result = await run('start.sh', ['--port', 'invalid']).done
  assert.equal(result.code, 1)
  assert.match(result.stderr, /1 到 65535/)
})
