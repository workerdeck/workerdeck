import { workspaceTestConfig } from '../../vitest.shared.ts'

// 20s, so `settles`'s own 15s deadline is the one that governs: vitest's 5s default killed the case first under a parallel `pnpm test`.
export default workspaceTestConfig({ test: { testTimeout: 20_000 } })
