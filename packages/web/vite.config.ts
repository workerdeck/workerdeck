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
    alias: [
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
      // Drop Monaco's four worker-backed language services — 8.8MB of the build (`ts.worker`
      // alone is 6.7MB) for IntelliSense in a pane meant for reading. Monarch highlighting is
      // a separate main-thread mechanism and is unaffected. An alias rather than a hand-written
      // Monaco entry because monaco-editor's exports map cannot resolve the `.css` subpaths
      // such an entry needs. An embedder who wants IntelliSense omits this alias.
      {
        // Matches the whole specifier: Vite substitutes only the matched span, so a partial
        // match leaves the `./` prefix glued to an absolute replacement path.
        find: /^.*languages\/features\/(css|html|json|typescript)\/register\.js$/,
        replacement: fileURLToPath(new URL('./monaco-no-language-services.js', import.meta.url)),
      },
    ],
  },
  build: { target: 'es2022' },
  // Monaco reaches its workers with `new Worker(new URL(..., import.meta.url))`. Vite's dev
  // dep optimizer rewrites the package into `.vite/deps/`, where that URL 404s and Monaco
  // silently runs the worker on the main thread — the freeze the worker exists to avoid.
  optimizeDeps: { exclude: ['monaco-editor'] },
  server: {
    port: 5191,
    // @fontsource woff2 lives outside the vite root in the workspace store.
    fs: { allow: ['../..'] },
    proxy: {
      '/v1': { target: workerUrl, changeOrigin: true, ws: true },
      // The app asks `/auth/status` who served it, so the dev server must look like a gateway
      // too, or the implicit host never appears.
      '/auth': { target: workerUrl, changeOrigin: true },
    },
  },
})
