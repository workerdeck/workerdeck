import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

/** Where the app server is listening; `pnpm dev` runs both. */
const appUrl = process.env.EMBEDDED_URL ?? 'http://127.0.0.1:8788'

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    // Dev runs the workspace packages from source, like every other entry here.
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // 5191 is packages/web, 5192 is apps/docs — this repo runs several dev
    // servers at once and a collision here is a confusing "why am I looking at
    // the docs site" rather than a clean failure.
    port: 5193,
    strictPort: true,
    // @fontsource and the workspace packages live outside this vite root.
    fs: { allow: ['../../..'] },
    // In dev the SPA is served by Vite and everything else by the app server, so
    // they are two origins — and the cookie is set by the app server. Proxying
    // keeps the browser on one origin anyway, which is what the production
    // single-port layout gives for free.
    // Every prefix the app server owns has to be listed. A missing one does not
    // fail loudly: Vite answers the SPA's `index.html` with a 200, so the caller
    // gets HTML where it expected JSON and the feature just quietly never loads.
    // That is what happened to `/trpc` when the wiki's data moved onto it.
    proxy: {
      '/v1': { target: appUrl, changeOrigin: false, ws: true },
      '/api': { target: appUrl, changeOrigin: false },
      '/trpc': { target: appUrl, changeOrigin: false },
    },
  },
})
