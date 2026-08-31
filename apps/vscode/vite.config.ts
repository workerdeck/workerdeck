import { fileURLToPath } from 'node:url'
import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

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
        main: fileURLToPath(new URL('./webview/main.tsx', import.meta.url)),
        sidebar: fileURLToPath(new URL('./webview/sidebar/main.tsx', import.meta.url)),
        gateways: fileURLToPath(new URL('./webview/gateways/main.tsx', import.meta.url)),
        sections: fileURLToPath(new URL('./webview/sections/main.tsx', import.meta.url)),
      },
      output: {
        // Fixed names so the providers can reference `main.js`/`main.css` without reading a manifest.
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info) => (info.names.some((n) => n.endsWith('.css')) ? 'main.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
})
