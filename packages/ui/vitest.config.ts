import { defineConfig } from 'vitest/config'

/**
 * `ui` tests the pure modules only — deliberately.
 *
 * The split this package needs is unusually clean: the terminal theme's
 * *geometry* (does the rendered row come out the height the calculator
 * predicted) genuinely needs a browser, because jsdom has no text layout, and it
 * already has its own gate in `dev/height-audit.ts` measuring against real
 * layout. Everything else here — which rows exist, what a run's line says, how
 * much of a result a collapsed row keeps, which marks the rail paints — is a
 * string-and-array contract with no DOM in it at all, and those are the ones
 * that have shipped bugs.
 *
 * So: no jsdom, no @testing-library, no render. A test here that needed a DOM
 * would be a test that belongs in the playground audit instead.
 */
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
