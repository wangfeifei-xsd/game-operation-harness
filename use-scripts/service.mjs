/** 本地 Web 服务的安装、启动和进程组关闭；运行记录及日志保存在忽略目录中。 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = dirname(dirname(script))
const output = join(root, 'output', 'local-service')
const recordPath = join(output, 'service.json')
const lockPath = join(output, 'operation.lock')
const logPath = join(output, 'web.log')
const installStamp = join(output, 'dependencies.sha256')
const environment = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }

/** 缺失记录表示未启动；损坏记录直接报错，避免按不完整的 PID 操作。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`无法读取运行记录 ${path}：${error.message}`)
  }
}

function writeRecord(record) {
  const temporary = `${recordPath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(temporary, recordPath)
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

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

/** 同时核对进程组、脚本路径和每次启动的随机标记，防止 PID 复用误关其他服务。 */
function ownsProcess(record) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.token !== 'string') return false
  const result = spawnSync('ps', ['-p', String(record.pid), '-o', 'pgid=', '-o', 'command='], { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status === 1) return false
  if (result.status !== 0) throw new Error(`无法核对服务进程：${result.stderr.trim()}`)
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/)
  return match !== null && Number(match[1]) === record.pid
    && match[2].includes(`${script} _run ${record.token} `)
}

/** 启停操作互斥；依赖安装和构建由后台进程执行，不占用此锁。 */
async function withLock(operation) {
  mkdirSync(output, { recursive: true, mode: 0o700 })
  let descriptor
  try {
    descriptor = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const owner = readJson(lockPath)
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 1 && !isAlive(owner.pid)) {
      throw new Error(`上次启停操作被中断，请删除遗留锁文件后重试：${lockPath}`)
    }
    throw new Error(`另一个启停操作正在执行，请稍后重试。锁文件：${lockPath}`)
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`)
    return await operation()
  } finally {
    closeSync(descriptor)
    unlinkSync(lockPath)
  }
}

async function assertFreePort({ host, port }, environmentName) {
  const server = createServer()
  server.listen(port, host)
  try {
    await once(server, 'listening')
  } catch (error) {
    throw new Error(`无法使用 ${host}:${port}：${error.message}。请修改 config/environments/${environmentName}.json 的 server.port 后重试。`)
  }
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function parseStart(args) {
  let environmentName = 'test'
  let noOpen = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--no-open') noOpen = true
    else if (args[index] === '--environment') {
      const value = args[++index]
      if (!['dev', 'test', 'fat', 'master'].includes(value)) {
        throw new Error('--environment 需要填写 dev、test、fat 或 master。')
      }
      environmentName = value
    } else if (args[index] === '--port') {
      throw new Error('监听端口请在 config/environments/<环境>.json 的 server.port 中配置，启动参数不覆盖部署文件。')
    } else throw new Error(`不支持的参数：${args[index]}。使用 --help 查看用法。`)
  }
  return { environmentName, noOpen }
}

/** 只探测公开登录页；根页面和业务接口在未登录时拒绝访问属于正常行为。 */
async function pageReady(entryUrl) {
  const response = await fetch(entryUrl, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
  await response.body?.cancel()
  return response.status === 200
}

async function start(options) {
  const record = await withLock(async () => {
    const previous = readJson(recordPath)
    if (ownsProcess(previous)) {
      if (previous.environment !== options.environmentName) {
        throw new Error('本项目已在运行其他环境或旧版服务，请先执行 ./use-scripts/stop.sh 再切换环境。')
      }
      console.log(`服务已在运行或启动中（${previous.environment}）。`)
      return previous
    }
    const token = randomUUID()
    const descriptor = openSync(logPath, 'w', 0o600)
    let child
    try {
      child = spawn(process.execPath, [script, '_run', token, options.environmentName, String(options.noOpen)], {
        cwd: root, env: environment, detached: true, stdio: ['ignore', descriptor, descriptor],
      })
      await once(child, 'spawn')
    } finally {
      closeSync(descriptor)
    }
    child.unref()
    const created = { pid: child.pid, token, environment: options.environmentName, phase: 'starting' }
    writeRecord(created)
    return created
  })
  console.log(`日志：${logPath}`)
  let phase
  while (true) {
    const current = readJson(recordPath)
    if (current?.token !== record.token || !ownsProcess(record) || current.phase === 'failed') {
      throw new Error(current?.message ?? `服务启动已结束，请检查日志：${logPath}`)
    }
    if (phase !== current.phase) {
      phase = current.phase
      const messages = { starting: '正在检查启动环境…', installing: '正在安装依赖…', serving: '正在构建并启动 Web 服务…' }
      if (messages[phase]) console.log(messages[phase])
    }
    if (phase === 'serving' && current.entryUrl) {
      try {
        if (await pageReady(current.entryUrl) && ownsProcess(record)) {
          console.log(`启动成功：${current.entryUrl}`)
          return
        }
      } catch (error) {
        if (!(error instanceof TypeError) && error.name !== 'TimeoutError') throw error
      }
    }
    await delay(300)
  }
}

async function waitForExit(pid, timeout) {
  const deadline = Date.now() + timeout
  while (isAlive(-pid)) {
    if (Date.now() >= deadline) return false
    await delay(100)
  }
  return true
}

async function stop() {
  await withLock(async () => {
    const record = readJson(recordPath)
    if (!ownsProcess(record)) {
      if (record !== undefined) unlinkSync(recordPath)
      console.log('服务未运行。')
      return
    }
    // 后台管理进程是独立进程组的组长，所有构建和服务子进程都属于该组。
    console.log('正在关闭服务及其子进程…')
    signalGroup(record.pid, 'SIGTERM')
    if (!await waitForExit(record.pid, 15000)) {
      signalGroup(record.pid, 'SIGKILL')
      if (!await waitForExit(record.pid, 5000)) {
        throw new Error(`进程组 ${record.pid} 尚未退出，运行记录已保留，请检查日志：${logPath}`)
      }
    }
    unlinkSync(recordPath)
    console.log('服务已关闭。')
  })
}

/** 每个子命令退出后再推进阶段；关闭信号同时传到本次启动的整个进程组。 */
async function runWorker(token, environmentName, noOpen) {
  let stopping = false
  const onSignal = () => { stopping = true }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  let record
  for (let attempt = 0; attempt < 100; attempt += 1) {
    record = readJson(recordPath)
    if (record?.token === token && record.pid === process.pid) break
    await delay(50)
  }
  if (record?.token !== token || record.pid !== process.pid) throw new Error('启动记录未建立，后台进程已退出。')
  const phase = (name, message) => {
    record = { ...record, phase: name, message }
    if (readJson(recordPath)?.token === token) writeRecord(record)
  }
  const run = async (command, args) => {
    if (stopping) throw new Error('启动已取消。')
    console.log(`执行：${command} ${args.join(' ')}`)
    const child = spawn(command, args, { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'inherit'] })
    let pending = ''
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk)
      pending += chunk.toString()
      let end
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trim()
        pending = pending.slice(end + 1)
        const match = line.match(/^Harness: (http:\/\/\S+)$/)
        // 仅接受本次产品入口实际监听、且与所选部署配置一致的地址。
        if (record.phase === 'serving' && match?.[1] === `${record.origin}/`) {
          record = { ...record, entryUrl: new URL('/harness/login', record.origin).href }
          if (readJson(recordPath)?.token === token) writeRecord(record)
        }
      }
    })
    const [code, signal] = await once(child, 'close')
    if (stopping) throw new Error('服务已关闭。')
    if (code !== 0) throw new Error(`${command} 执行失败（${signal ?? code}），请检查日志：${logPath}`)
  }
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const required = manifest.engines.node.match(/^>=(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number)
    const actual = process.versions.node.split('.').map(Number)
    if (!required || actual[0] < required[0]
      || (actual[0] === required[0] && actual[1] < required[1])
      || (actual[0] === required[0] && actual[1] === required[1] && actual[2] < required[2])) {
      throw new Error(`需要 Node.js ${manifest.engines.node}，当前版本为 ${process.version}。`)
    }
    const expected = manifest.packageManager.replace(/^pnpm@/, '').split('+')[0]
    let command = 'pnpm'
    let prefix = []
    let version = spawnSync(command, ['--version'], { cwd: root, env: environment, encoding: 'utf8' })
    if (version.error?.code === 'ENOENT' || version.stdout?.trim() !== expected) {
      command = 'corepack'
      prefix = ['pnpm']
      version = spawnSync(command, [...prefix, '--version'], { cwd: root, env: environment, encoding: 'utf8' })
    }
    if (version.status !== 0 || version.stdout?.trim() !== expected) {
      throw new Error(`需要 pnpm ${expected}，请安装匹配版本或启用 Corepack。${version.stderr ?? ''}`)
    }
    const hash = createHash('sha256')
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) hash.update(readFileSync(join(root, file)))
    const fingerprint = hash.digest('hex')
    if (!existsSync(join(root, 'node_modules', '.modules.yaml'))
      || !existsSync(installStamp) || readFileSync(installStamp, 'utf8') !== fingerprint) {
      phase('installing')
      await run(command, [...prefix, 'install', '--frozen-lockfile'])
      writeFileSync(installStamp, fingerprint, { mode: 0o600 })
    }
    // 安装依赖后复用产品配置校验器，避免脚本另行解析或覆盖部署设置。
    const { tsImport } = await import('tsx/esm/api')
    const { readHarnessConfig } = await tsImport('../apps/cli/src/harness-config.ts', import.meta.url)
    const { server } = readHarnessConfig(environmentName)
    await assertFreePort(server, environmentName)
    const host = server.host === '::1' ? '[::1]' : server.host
    record = { ...record, host: server.host, port: server.port, origin: `http://${host}:${server.port}` }
    phase('serving')
    const args = [...prefix, 'run', 'dev:web', '--environment', environmentName]
    if (noOpen) args.push('--no-open')
    await run(command, args)
    throw new Error('Web 服务已退出。')
  } catch (error) {
    console.error(error.message)
    phase(stopping ? 'stopped' : 'failed', error.message)
    if (!stopping) {
      process.exitCode = 1
      signalGroup(process.pid, 'SIGTERM')
    }
  }
}

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log('启动：./use-scripts/start.sh [--environment dev|test|fat|master] [--no-open]\n关闭：./use-scripts/stop.sh\n默认环境为 test，监听地址和端口读取 config/environments/<环境>.json。\n首次启动安装依赖，每次启动构建并监听源码变化；日志保存在 output/local-service/web.log。')
    return
  }
  if (action === '_run') await runWorker(args[0], args[1], args[2] === 'true')
  else if (action === 'start') await start(parseStart(args))
  else if (action === 'stop' && args.length === 0) await stop()
  else throw new Error('请使用 start.sh 或 stop.sh；使用 --help 查看用法。')
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
