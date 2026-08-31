import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

const workerUrl = process.env.WORKER_URL ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@workerdeck/source', ...defaultClientConditions],
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      {
        // Matches the whole specifier: Vite substitutes only the matched span, so a partial match would leave the
        // `./` prefix glued to an absolute replacement path.
        find: /^.*languages\/features\/(css|html|json|typescript)\/register\.js$/,
        replacement: fileURLToPath(new URL('./monaco-no-language-services.js', import.meta.url)),
      },
    ],
  },
  build: { target: 'es2022' },
  optimizeDeps: { exclude: ['monaco-editor'] },
  server: {
    port: 5191,
    // @fontsource's woff2 files live outside the vite root, in the workspace store.
    fs: { allow: ['../..'] },
    proxy: {
      '/v1': { target: workerUrl, changeOrigin: true, ws: true },
      // The app asks `/auth/status` who served it, so the dev server has to look like a gateway or no implicit host appears.
      '/auth': { target: workerUrl, changeOrigin: true },
    },
  },
})
