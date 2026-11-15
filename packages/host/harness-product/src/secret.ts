/** 本机凭据只验证父子进程归属，不代表产品账号授权。 */
import { timingSafeEqual } from 'node:crypto'

/**
 * 固定长度比较本机随机凭据。
 * @param actual - 请求提供的值。
 * @param expected - 当前进程内存中的秘密。
 * @returns 两者是否精确一致。
 */
export function sameHarnessSecret(actual: string | undefined, expected: string): boolean {
  return actual !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(actual)
    && /^[A-Za-z0-9_-]{43}$/u.test(expected)
    && timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
}
