import { workspaceTestConfig } from '../../vitest.shared.ts'

// `web` is an app with no `src/index.ts`; overrides' aliases match before the shared rule.
export default workspaceTestConfig({
  test: { pool: 'forks' },
  resolve: { alias: [{ find: '@workerdeck/web', replacement: `${import.meta.dirname}/../web/entry.mjs` }] },
})
