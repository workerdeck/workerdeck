import { workspaceTestConfig } from '../../vitest.shared.ts'

export default workspaceTestConfig({ test: { pool: 'forks' } })
