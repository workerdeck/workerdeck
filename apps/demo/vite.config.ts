import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['@workerdeck/source', ...defaultClientConditions],
  },
  build: { target: 'es2022' },
  server: { port: 5195, strictPort: true, fs: { allow: ['../..'] } },
})
