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
      // Drop Monaco's four worker-backed language services (TypeScript, JSON,
      // CSS, HTML). They are 8.8MB of the build — `ts.worker` alone is 6.7MB of
      // TypeScript compiler — and they buy IntelliSense and schema validation
      // in a pane whose job is reading and small edits to what the agent wrote.
      // Monarch highlighting for ~90 languages is unaffected: it is a separate
      // mechanism (`languages/definitions/*`) that runs on the main thread.
      //
      // Done here rather than with a hand-written Monaco entry because the entry
      // also imports two CSS files (`codicon.css` — the icon font), and
      // monaco-editor's exports map (`"./*": "./esm/vs/*.js"`) cannot resolve a
      // `.css` subpath at all, so the entry is only writable from inside the
      // package. An embedder who wants IntelliSense simply omits this alias.
      {
        // Matches the whole specifier, not a suffix of it — Vite substitutes only
        // the matched span, so a partial match would leave the `./` prefix glued
        // to an absolute replacement path.
        find: /^.*languages\/features\/(css|html|json|typescript)\/register\.js$/,
        replacement: fileURLToPath(new URL('./monaco-no-language-services.js', import.meta.url)),
      },
    ],
  },
  build: { target: 'es2022' },
  // Monaco reaches its own web workers with `new Worker(new URL('...',
  // import.meta.url))` — the bundler-standard form, which Rollup resolves at
  // build time. Vite's dev-time dep optimizer, though, rewrites the package into
  // `.vite/deps/`, and the worker URL then resolves relative to *there* and
  // 404s: Monaco logs "Failed to load worker script" and falls back to running
  // the worker code on the main thread, which is exactly the UI freeze the
  // worker exists to avoid. Excluding it from pre-bundling leaves the imports
  // pointing at the real files in node_modules, where the relative URL is right.
  optimizeDeps: { exclude: ['monaco-editor'] },
  server: {
    port: 5191,
    // @fontsource woff2 lives outside the vite root in the workspace store.
    fs: { allow: ['../..'] },
    proxy: {
      '/v1': { target: workerUrl, changeOrigin: true, ws: true },
    },
  },
})
