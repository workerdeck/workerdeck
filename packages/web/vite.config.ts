import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

// Proxy /v1 (REST + WS) to the local workerdeck dev server (`pnpm server`).
const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@workerdeck/source', ...defaultClientConditions],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: { target: 'es2022' },
  server: {
    port: 5191,
    // @fontsource woff2 lives outside the vite root in the workspace store.
    fs: { allow: ['../..'] },
    proxy: {
      '/v1': { target: workerUrl, changeOrigin: true, ws: true },
    },
  },
})
