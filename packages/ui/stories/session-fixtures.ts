import { sessionState } from '@workerdeck/protocol'
import type { SessionInfo, SessionRow, SubagentInfo } from '@workerdeck/protocol'

// Ages are offsets from *now*, never a frozen epoch: the card draws `formatRelativeTime`, so a fixed timestamp drifts while a fixed offset renders the same two characters forever.
const MINUTE = 60_000

export const AGENTS: SubagentInfo[] = [
  { toolUseId: 'a', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'running', toolCount: 7 },
  { toolUseId: 'c', agentType: 'fable', description: 'Fix base-url and re-run', status: 'done', toolCount: 0 },
] as unknown as SubagentInfo[]

const WD = {
  name: 'WorkerDeck',
  root: '/Users/atomic/projects/ai/workerdeck',
  icon: { type: 'glyph', name: 'layers' },
}

export const makeInfo = (patch: Partial<SessionInfo> & { id: string }): SessionInfo => {
  return {
    engine: 'claude',
    status: 'running',
    model: 'claude-opus-5-20260101',
    cwd: '/Users/atomic/projects/ai/workerdeck',
    createdAt: Date.now() - 40 * MINUTE,
    lastActivityAt: Date.now() - 4 * MINUTE,
    lastSeq: 0,
    pendingPermissionCount: 0,
    project: WD,
    contextUsage: { percentage: 34, totalTokens: 68_000, maxTokens: 200_000 },
    ...patch,
  } as unknown as SessionInfo
}

export const makeRow = (patch: Partial<SessionInfo> & { id: string }, unseen = 0): SessionRow => {
  const info = makeInfo(patch)
  return {
    hostId: 'local',
    hostName: 'local',
    local: true,
    adapter: 'claude',
    state: sessionState(info),
    info,
    unseen,
  }
}

export const MIXED: SubagentInfo[] = [
  { toolUseId: 'a', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', agentType: 'fable', description: 'Fix base-url and re-run', status: 'running', toolCount: 7 },
  { toolUseId: 't1', description: 'Fix base-url and re-run', status: 'done', toolCount: 0 },
] as unknown as SubagentInfo[]
