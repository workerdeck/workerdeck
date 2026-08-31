import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

const appUrl = process.env.EMBEDDED_URL ?? 'http://127.0.0.1:8788'

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5193,
    strictPort: true,
    fs: { allow: ['../../..'] },
    // Every prefix the app server owns must be listed: a missing one gets `index.html` with a 200, not a failure.
    proxy: {
      '/v1': { target: appUrl, changeOrigin: false, ws: true },
      '/api': { target: appUrl, changeOrigin: false },
      '/trpc': { target: appUrl, changeOrigin: false },
    },
  },
})
