/** 真实后代脱离父进程后仍按启动身份停止，不影响不属于该 Host 的进程。 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it, onTestFinished } from 'vitest'
import { createProcessInspector, type ProcessIdentity } from '@deepseek-ai/dsh-subprocess-local/process-inspector'
import { HarnessProcessTree } from '../src/process-tree.ts'

it.skipIf(process.platform === 'win32')('stops an observed orphan and preserves an unrelated process', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    child.unref()
    process.send({ pid: child.pid })
    process.on('message', () => process.exit(0))
  `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const tree = new HarnessProcessTree(parent)
  const inspector = createProcessInspector()
  const observed: { orphan?: ProcessIdentity } = {}
  onTestFinished(async () => {
    tree.terminateOnExit(); unrelated.kill('SIGKILL'); parent.kill('SIGKILL')
    if (observed.orphan !== undefined) inspector.signalProcess(observed.orphan, 'SIGKILL')
  })
  const [message] = await once(parent, 'message') as [{ pid: number }]
  const orphan = inspector.snapshot().tree(parent.pid!).find(identity => identity.pid === message.pid)
  if (orphan !== undefined) observed.orphan = orphan
  expect(orphan).toBeDefined()
  tree.observe()
  const exit = once(parent, 'exit')
  parent.send('exit')
  await exit
  await expect(tree.stop(3000, () => {})).resolves.toBe(true)
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow()
  expect(inspector.snapshot().alive(orphan!)).toBe(false)
}, 10_000)
