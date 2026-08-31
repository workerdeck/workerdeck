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
  test: { include: ['test/**/*.test.ts'] },
})
