import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['@workerdeck/source'],
    alias: [
      // Keep first: aliases match in order, and `web` is an app with no `src/index.ts` for the rule below to find.
      {
        find: '@workerdeck/web',
        replacement: `${import.meta.dirname}/../web/entry.mjs`,
      },
      {
        find: /^@workerdeck\/([a-z-]+)$/,
        replacement: `${import.meta.dirname}/../$1/src/index.ts`,
      },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
})
