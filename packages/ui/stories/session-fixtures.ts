import { sessionState } from '@workerdeck/protocol'
import type { SessionInfo, SessionRow, SubagentInfo } from '@workerdeck/protocol'

/**
 * Canned rows for the session-list stories.
 *
 * Ages are offsets from *now*, not from a frozen timestamp. That looks like the
 * less reproducible choice and is the opposite: the card draws
 * `formatRelativeTime`, so a fixed epoch drifts (`4m ago` today, `three weeks
 * ago` next month, `just now` if the clock is ahead of it) while a fixed
 * *offset* renders the same two characters forever.
 */
const MINUTE = 60_000

/**
 * Three sub-agents, one per state the step row draws.
 *
 * `agentType` is what makes these *agents* rather than tasks (`isAgentRecord`),
 * and the distinction is not cosmetic: an agent is pressable and wears the
 * sub-agent colour, a task is inert and muted. A fixture without it silently
 * exercises the wrong half of the component.
 */
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

export function makeInfo(patch: Partial<SessionInfo> & { id: string }): SessionInfo {
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

export function makeRow(patch: Partial<SessionInfo> & { id: string }, unseen = 0): SessionRow {
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

/**
 * Two agents and a task, which is what the selection stories need: the rule that
 * a task can be pressed but never selected is unfalsifiable against a list with
 * no task in it.
 *
 * A task is a record with no `agentType` — the model described a piece of work
 * and no agent was dispatched for it, so there is nothing to open and the row is
 * a reference to a place in the transcript instead.
 */
export const MIXED: SubagentInfo[] = [
  { toolUseId: 'a', agentType: 'Explore', description: 'Fix base-url and re-run', status: 'done', toolCount: 4 },
  { toolUseId: 'b', agentType: 'fable', description: 'Fix base-url and re-run', status: 'running', toolCount: 7 },
  { toolUseId: 't1', description: 'Fix base-url and re-run', status: 'done', toolCount: 0 },
] as unknown as SubagentInfo[]
