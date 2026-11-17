/** 配置层的纯数据检查与合并。 */

/** 判断配置值是否为普通对象。
 * @param value - 待检查的值。
 * @returns 是否可以按字段合并。
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 递归合并普通对象；数组和标量整体覆盖。
 * @param under - 继承层。
 * @param over - 不含 undefined 字段的覆盖层。
 * @returns 合并后的配置，不修改输入。
 */
export function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
      enumerable: true, configurable: true, writable: true,
    })
  }
  return merged
}
