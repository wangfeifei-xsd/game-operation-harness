/** 登录页单独构建，只包含公开认证 UI。 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  base: '/harness/assets/',
  build: {
    outDir: 'harness-dist', emptyOutDir: true, cssCodeSplit: false,
    rollupOptions: {
      input: { auth: fileURLToPath(new URL('./harness/auth.tsx', import.meta.url)) },
      output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js', assetFileNames: '[name][extname]' },
    },
  },
})
