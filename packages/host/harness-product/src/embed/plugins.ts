import { createHash } from 'node:crypto'

declare module '@deepseek-ai/cordis' {
  interface Context {
    harnessEmbedPlugins: EmbedPluginRegistry
  }
}

/** 插件提供不依赖外部资源的浏览器模块，由本机插件启停控制注册。 */
export interface EmbedPlugin {
  id: string
  name: string
  protocol: number
  source: string
}

interface PluginSummary { id: string; name: string; revision: string }

/** 业务会话只读取当前运行环境已登记的资源，不解析网页提供的路径。 */
export class EmbedPluginRegistry {
  private readonly plugins = new Map<string, { summary: PluginSummary; source: string }>()

  constructor(private readonly changed: () => void) {}

  /**
   * 登记当前插件的隔离网页模块。
   * @param plugin - 模块标识、显示名称、协议版本及自包含的源码。
   * @returns 由插件注册生命周期持有的清理函数。
   */
  register(plugin: EmbedPlugin): () => void {
    if (plugin.protocol !== 1) return () => {}
    if (!/^[a-z0-9@][a-z0-9@/._-]{0,119}$/u.test(plugin.id) || !plugin.name.trim() || plugin.name.length > 80
      || !plugin.source || Buffer.byteLength(plugin.source) > 256 * 1024 || this.plugins.size >= 16
      || this.plugins.has(plugin.id)) throw new Error('业务会话插件登记无效')
    const revision = createHash('sha256').update(plugin.source).digest('hex')
    this.plugins.set(plugin.id, { summary: { id: plugin.id, name: plugin.name, revision }, source: plugin.source })
    this.changed()
    return () => {
      if (this.plugins.get(plugin.id)?.summary.revision === revision) {
        this.plugins.delete(plugin.id)
        this.changed()
      }
    }
  }

  /**
   * 列出当前会话可用的已登记模块。
   * @returns 模块名称与版本清单，不含源码。
   */
  list(): PluginSummary[] {
    return [...this.plugins.values()].map(plugin => plugin.summary)
  }

  /**
   * 按清单读取仍在登记的模块。
   * @param id - 清单中的模块标识。
   * @param revision - 清单中的模块内容摘要，防止换版期间加载旧代码。
   * @returns 当前登记版本的模块源码。
   */
  load(id: string, revision: string): { source: string } {
    const plugin = this.plugins.get(id)
    if (!plugin || plugin.summary.revision !== revision) throw new Error('会话插件已停用或更新，请重新连接')
    return { source: plugin.source }
  }
}
