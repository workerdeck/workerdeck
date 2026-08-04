import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['@workerdeck/source'],
    // vite-node externalizes workspace deps to their (unbuilt) build/ entries; alias
    // them to TS source so tests run without a build step.
    alias: [
      // `web` is an app, not a library: it has no src/index.ts for the rule
      // below to find. Its entry is a hand-written path helper, so point at that
      // directly — and keep it first, since aliases match in order.
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
