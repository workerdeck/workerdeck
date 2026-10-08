import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: './src/index.ts', 'accounts/index': './src/accounts/index.ts' },
  outDir: 'build',
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: [/^[^./]/] },
})
