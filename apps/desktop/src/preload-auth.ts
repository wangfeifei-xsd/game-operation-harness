/** 登录页面只有固定账号请求和状态订阅，不提供 Node 或通用 IPC。 */
import { contextBridge, ipcRenderer } from 'electron'
import { PRODUCT_IPC, type ProductReply } from './product-protocol.ts'

if (process.isMainFrame && location.href === 'dsh-app://auth/') {
  contextBridge.exposeInMainWorld('agentAssistantAccount', {
    request: (operation: string, body?: object): Promise<ProductReply> => ipcRenderer.invoke(PRODUCT_IPC.request, operation,
      body) as Promise<ProductReply>,
    subscribe: (listener: (state: object) => void): (() => void) => {
      const receive = (_event: Electron.IpcRendererEvent, state: object): void => { listener(state) }
      ipcRenderer.on(PRODUCT_IPC.changed, receive)
      return () => { ipcRenderer.off(PRODUCT_IPC.changed, receive) }
    },
  })
}
