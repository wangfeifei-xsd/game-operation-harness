/** 构建安装包内的静态登录页，全部依赖均在本地资源中。 */
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({ root: fileURLToPath(new URL('./auth', import.meta.url)), base: './',
  resolve: { dedupe: ['react','react-dom'] },
  build: { outDir: '../lib/auth', emptyOutDir: true },
})
