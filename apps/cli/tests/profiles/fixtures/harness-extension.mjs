/** 在真实账号 Host 中验证扩展路由的装载、卸载和重新装载。 */
export const name = 'harness-extension-fixture'
export const inject = ['webServer', 'agents', 'skills', 'workingDirectory']

/**
 * @param ctx - Loader 创建的插件上下文。
 * @param config - 测试指定的路由路径。
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: config.path,
    handler: async (request, response) => {
      const sessionId = new URL(request.url, 'http://fixture').searchParams.get('sessionId')
      const agent = sessionId === null ? undefined : ctx.agents.get(sessionId)
      const skills = agent === undefined ? [] : await ctx.skills.list({ scope: agent, cwd: await ctx.workingDirectory.ensure(agent) })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ extension: 'active', ...(sessionId === null ? {} : { skills: skills.map(skill => skill.name) }) }))
    },
  }))
}
