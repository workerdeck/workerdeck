import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

/**
 * Webview bundle: React + `@workerdeck/ui`'s ROOT entry (SessionPanel — no
 * Monaco, no workspace; VS Code is the workspace). Output names are fixed so
 * the WebviewViewProvider can reference `main.js` / `main.css` without reading
 * a manifest; lazy chunks keep hashed names and load relative to `main.js`,
 * which works under `vscode-webview://` because module URLs resolve against the
 * importing module.
 *
 * No dev server: webview assets must be real files on disk (`localResourceRoots`),
 * so the dev loop is `vite build --watch`. That also means Vite's dep optimizer
 * never runs here — no Monaco-style optimizeDeps traps to inherit.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist/webview',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        // Four bundles, one stylesheet: the agent panel, the Sessions view, the
        // Gateways view, and the shared entry every section view
        // (info/context/usage/mcp) boots with — the provider stamps which one
        // onto the root element.
        main: fileURLToPath(new URL('./webview/main.tsx', import.meta.url)),
        sidebar: fileURLToPath(new URL('./webview/sidebar/main.tsx', import.meta.url)),
        gateways: fileURLToPath(new URL('./webview/gateways/main.tsx', import.meta.url)),
        sections: fileURLToPath(new URL('./webview/sections/main.tsx', import.meta.url)),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info) =>
          info.names.some((n) => n.endsWith('.css')) ? 'main.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
})
