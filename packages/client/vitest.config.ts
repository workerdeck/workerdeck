import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['@workerdeck/source'],
    // vite-node externalizes workspace deps to their (unbuilt) build/ entries; alias
    // them to TS source so tests run without a build step.
    alias: [
      {
        find: /^@workerdeck\/([a-z-]+)$/,
        replacement: `${import.meta.dirname}/../$1/src/index.ts`,
      },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
})
