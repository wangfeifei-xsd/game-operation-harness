/** 账号 IPC 仅允许已创建窗口的准确主页面及固定认证操作。 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { HarnessAuthError } from '@deepseek-ai/dsh-host-harness-product/auth-client'
import type { DesktopProductSession } from './product-session.ts'

import { PRODUCT_IPC, type ProductReply } from './product-protocol.ts'

/**
 * 当前窗口及主 frame 同时校验，旧窗口、子 frame、外部页都拒绝。
 * @param event - Renderer 调用事件。
 * @param owner - 当前受管窗口。
 * @param address - 唯一允许的本地页面地址。
 */
export function assertProductWindow(event: IpcMainInvokeEvent, owner: BrowserWindow | undefined, address: string): void {
  if (owner === undefined || owner.isDestroyed() || event.sender !== owner.webContents
    || event.senderFrame !== owner.webContents.mainFrame ||
      event.senderFrame.url !== address) throw new HarnessAuthError(403, 'HARNESS_ORIGIN_DENIED', '请求来源无效')
}

const login = z.object({ login_name: z.string().min(3).max(128), password: z.string().min(1).max(4096),
  captcha_token: z.string().min(1).max(4096) }).strict()
const registration = login.extend({ display_name: z.string().min(1).max(128) })
const challenge = z.object({ login_name: z.string().min(3).max(128) }).strict()
const verification = z.object({ challenge_id: z.string().min(1).max(256), offset: z.number().min(0).max(4096) }).strict()
const challengeResult = z.object({ challenge_id: z.string(), background: z.string().max(2_000_000), piece: z.string().max(2_000_000),
  piece_y: z.number().nonnegative(), piece_size: z.number().positive(), width: z.number().positive(), height: z.number().positive() })

/**
 * 注册窄账号 API；聊天页仅允许读取摘要、退出与可信活动续期。
 * @param product - 唯一产品会话所有者。
 * @param windows - 当前登录与聊天窗口。
 * @param activate - 完成产品登录后创建本代聊天窗口。
 */
export function installProductIpc(product: DesktopProductSession,
  windows: () => { auth: BrowserWindow | undefined; app: BrowserWindow | undefined }, activate: () => Promise<void>,
  pairing?: (operation: string, body: unknown) => Promise<unknown>): void {
  ipcMain.handle(PRODUCT_IPC.request, async (event, operation: unknown, body: unknown): Promise<ProductReply> => {
    try {
      const current = windows()
      const fromAuth = current.auth?.webContents === event.sender
      assertProductWindow(event, fromAuth ? current.auth : current.app, fromAuth ? 'dsh-app://auth/' : 'dsh-app://app/')
      if (typeof operation === 'string' && /^pairing\/(status|lookup|pick|claim|disconnect)$/u.test(operation)) {
        if (!pairing) throw new HarnessAuthError(503, 'HARNESS_UNAVAILABLE', '本机助手暂不可用')
        if (!fromAuth) await product.authorize()
        return { ok: true, value: await pairing(operation.slice('pairing/'.length), body) }
      }
      if (typeof operation !== 'string' || !fromAuth && !['session','logout',
        'renew'].includes(operation)) throw new HarnessAuthError(403, 'HARNESS_ORIGIN_DENIED', '请求来源无效')
      let value: unknown
      switch (operation) {
        case 'bootstrap': value = await product.auth.publicBootstrap(); break
        case 'session': value = product.state; break
        case 'login': value = await product.login(login.parse(body)); await activate(); break
        case 'register': {
          const rules = await product.auth.publicBootstrap()
          if (!rules.registration_enabled) throw new HarnessAuthError(403, 'HARNESS_REGISTRATION_DISABLED', '当前未开放注册')
          await product.auth.request('/auth/register', 'POST', registration.parse(body)); value = { registered: true }; break
        }
        case 'logout': value = await product.logout(); break
        case 'renew': await product.activity(); value = product.state; break
        case 'captcha/login/challenges': case 'captcha/register/challenges': {
          await product.auth.bootstrap()
          value = challengeResult.parse(await product.auth.request(`/auth/${operation}`, 'POST', challenge.parse(body))); break
        }
        case 'captcha/login/verify': case 'captcha/register/verify': {
          await product.auth.bootstrap()
          value = z.object({ captcha_token: z.string().max(4096),
            expires_in: z.number().positive() }).parse(await product.auth.request(`/auth/${operation}`, 'POST',
            verification.parse(body))); break
        }
        default: throw new HarnessAuthError(400, 'HARNESS_INPUT_INVALID', '认证操作无效')
      }
      return { ok: true, value }
    } catch (error) {
      if (!(error instanceof HarnessAuthError) && !(error instanceof z.ZodError)) console.error('桌面账号操作失败',
        error instanceof Error ? error.message : '未知错误')
      const known = error instanceof HarnessAuthError ? error : new HarnessAuthError(error instanceof z.ZodError ? 400 : 503, 'HARNESS_INPUT_INVALID', error instanceof z.ZodError ? '请求内容无效' : '服务暂不可用，请稍后重试')
      return { ok: false, error: { status: known.status, code: known.code, message: known.message } }
    }
  })
}
