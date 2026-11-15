/** 沙箱 preload 与主进程共用的纯数据协议。 */
/** 主进程内固定通道，未暴露通用 IPC 能力。 */
export const PRODUCT_IPC = { request: 'agent-assistant:account', changed: 'agent-assistant:account-changed' } as const
/** 错误跨 IPC 使用公开 DTO，避免 Electron 丢失业务信息。 */
export type ProductReply = { ok: true; value: unknown } | { ok: false; error: { status: number; code: string; message: string } }

