/** 将实际环境文件和独立认证页面一同放入 dsh 分发资源。 */
import { cp, mkdir } from 'node:fs/promises'
const resources = new URL('../apps/cli/lib/resources/', import.meta.url)
await mkdir(resources, { recursive: true })
await cp(new URL('../config/environments/', import.meta.url), new URL('environments/', resources), { recursive: true, force: true })
await cp(new URL('../apps/web/harness-dist/', import.meta.url), new URL('harness/', resources), { recursive: true, force: true })
