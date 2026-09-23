import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['@workerdeck/source'],
    alias: [
      {
        find: /^@workerdeck\/([a-z-]+)$/,
        replacement: `${import.meta.dirname}/../$1/src/index.ts`,
      },
    ],
  },
  // 20s, so `settles`'s own 15s deadline is the one that governs. It was raised to 15s after the
  // flake that failed the v0.9.0 publish and never used a second of it: vitest's default 5s test
  // budget killed the case first, which is how the same starved retry timer came back under a
  // parallel `pnpm test`.
  test: { include: ['test/**/*.test.ts'], testTimeout: 20_000 },
})
