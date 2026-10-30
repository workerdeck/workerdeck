import { defineConfig, mergeConfig, type ViteUserConfig } from 'vitest/config'

const PACKAGES = `${import.meta.dirname}/packages`

// Threads unless a package needs a process of its own (native PTYs, process-wide state, WASM memory caps): `forks`.
// vite-node externalizes workspace siblings to their unbuilt build/ entries, so each one is aliased to its TS source.
export function workspaceTestConfig(overrides: ViteUserConfig = {}): ViteUserConfig {
  return mergeConfig(
    defineConfig({
      resolve: {
        conditions: ['@workerdeck/source'],
        alias: [{ find: /^@workerdeck\/([a-z-]+)$/, replacement: `${PACKAGES}/$1/src/index.ts` }],
      },
      test: { include: ['test/**/*.test.ts'], pool: 'threads' },
    }),
    overrides,
  )
}
