import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['./src/index.ts', './src/workspace.ts'],
  outDir: 'build',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
})
