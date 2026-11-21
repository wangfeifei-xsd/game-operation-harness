import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** 从工作区读取单个文件的字节上限。 */
export const MAX_FILE = 2 * 1024 * 1024

/**
 * 判断规范化的路径与本机授权目录的位置关系。
 * @param root - 本机授权目录的绝对路径。
 * @param path - 待验证的绝对路径。
 * @returns 路径位于目录内或与目录相同。
 */
export function within(root: string, path: string): boolean {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/**
 * 将本机选择的工作区解析为真实目录，并阻止其与私有数据目录重叠。
 * @param input - 本机选择的路径。
 * @param storage - 部署私有数据目录。
 * @returns 业务工作区的真实绝对路径。
 */
export async function canonicalWorkspace(input: unknown, storage: string): Promise<string> {
  if (typeof input !== 'string' || !isAbsolute(input) || input.length > 1024) throw new Error('请选择本机工作区')
  const [path, privateRoot] = await Promise.all([realpath(input), realpath(storage)])
  if (within(path, privateRoot) || within(privateRoot, path) || !(await lstat(path)).isDirectory()) {
    throw new Error('请选择业务文件目录')
  }
  return path
}

/**
 * 在已验证的父目录下创建或打开会话私有目录。
 * @param parent - 已解析的父目录绝对路径。
 * @param name - 调用方指定的单层目录名称。
 * @returns 不经过符号链接的会话目录。
 */
export async function privateDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
  })
  if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new Error('业务会话目录无效')
  return path
}

/**
 * 读取工作区文件，拒绝目录链接、终点链接及硬链接。
 * @param root - 已授权的工作区真实路径。
 * @param input - 相对于工作区的文件路径。
 * @returns 打开后校验过大小与归属的文件内容。
 */
export async function readScopedFile(root: string, input: string): Promise<Buffer> {
  if (!input || isAbsolute(input) || input.includes('\0') || input.split(/[\\/]/u).some(part => part === '..')) {
    throw new Error('请输入工作区内的相对文件路径')
  }
  const path = resolve(root, input)
  if (!within(root, path) || path === root || await realpath(path) !== path
    || !(await lstat(path)).isFile()) throw new Error('文件不在已授权的工作区')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stats = await file.stat()
    const current = await lstat(path)
    if (!stats.isFile() || stats.nlink !== 1 || stats.ino !== current.ino || stats.dev !== current.dev
      || stats.size > MAX_FILE || await realpath(path) !== path) throw new Error('文件不可读取或超过 2 MB')
    const buffer = Buffer.alloc(MAX_FILE + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_FILE) throw new Error('文件不能超过 2 MB')
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}
