import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

/**
 * Dev-only. `@workerdeck/ui` ships no application — this serves `dev/`, a
 * playground that renders the components against canned fixtures so the terminal
 * theme can be built and checked inside this package alone, without a gateway, a
 * live session, or a round trip through `web`/`apps/vscode`.
 *
 * The published build is tsdown (`tsdown.config.ts`); nothing here is packed.
 */
export default defineConfig({
  root: 'dev',
  plugins: [react(), tailwindcss()],
  resolve: {
    // Resolve sibling workspace packages to their sources, as every other dev
    // entry in the repo does — no build step between an edit and the page.
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  server: {
    port: 5193,
    // The fixtures import from ../src, and fontsource lives in the workspace store.
    fs: { allow: ['../..'] },
  },
})
