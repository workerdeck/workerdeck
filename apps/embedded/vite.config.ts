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
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  build: {
    target: 'es2022',
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // 5191 is packages/web, 5192 is apps/docs; a collision reads as "why am I
    // looking at the docs site" rather than a clean failure.
    port: 5193,
    strictPort: true,
    // @fontsource and the workspace packages live outside this vite root.
    fs: { allow: ['../../..'] },
    // The cookie is set by the app server, so the proxy keeps dev on one origin too.
    // **Every prefix the app server owns has to be listed.** A missing one does not fail
    // loudly: Vite answers `index.html` with a 200, so the caller gets HTML where it
    // expected JSON and the feature quietly never loads.
    proxy: {
      '/v1': { target: appUrl, changeOrigin: false, ws: true },
      '/api': { target: appUrl, changeOrigin: false },
      '/trpc': { target: appUrl, changeOrigin: false },
    },
  },
})
