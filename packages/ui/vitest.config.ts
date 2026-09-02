import { defineConfig } from 'vitest/config'

// `ui` tests the pure modules only — no jsdom, no @testing-library, no render. Geometry needs
// real text layout and is gated by `dev/height-audit.ts` in a browser instead, so a test here
// that wanted a DOM is a test that belongs in the playground audit. See docs/DEVELOPMENT.md.
export default defineConfig({
  resolve: {
    conditions: ['@workerdeck/source'],
    // vite-node externalizes workspace deps to their (unbuilt) build/ entries;
    // alias them to TS source so tests run without a build step.
    alias: [
      {
        find: /^@workerdeck\/([a-z-]+)$/,
        replacement: `${import.meta.dirname}/../$1/src/index.ts`,
      },
    ],
  },
  test: { include: ['test/**/*.test.ts'] },
})
