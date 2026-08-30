import { describe, expect, it } from 'vitest'
import { isAgentRecord } from '@workerdeck/protocol'
import type { SubagentInfo } from '@workerdeck/protocol'
import { sessionSteps } from '../src/components/agent/SessionSteps.tsx'
import type { SessionInfo } from '@workerdeck/protocol'

const sub = (over: Partial<SubagentInfo>): SubagentInfo => ({
  toolUseId: 't1',
  status: 'running',
  startedAt: 0,
  toolCount: 0,
  ...over,
})

/**
 * Which lines a person can press. An agent has work of its own and a frame to
 * show it in; a task does not, and a row that offered a screen and then drew an
 * empty one is worse than a row that offered nothing.
 */
describe('isAgentRecord', () => {
  it('is an agent when it carries a subagent type', () => {
    expect(isAgentRecord(sub({ agentType: 'Explore' }))).toBe(true)
    expect(isAgentRecord(sub({ agentType: 'Explore', description: 'find it' }))).toBe(true)
  })

  it('is a task with only a description, or with nothing at all', () => {
    expect(isAgentRecord(sub({ description: 'check the deploy' }))).toBe(false)
    expect(isAgentRecord(sub({}))).toBe(false)
  })

  it('does not count whitespace as an identity', () => {
    expect(isAgentRecord(sub({ agentType: '   ' }))).toBe(false)
  })
})

describe('sessionSteps', () => {
  /**
   * The bug this pins: every step used to be handed the same callback, so
   * pressing a **task** went down the sub-agent path and the panel framed a
   * tool-use id with no agent behind it — `subagentItems` matched nothing and it
   * drew an **empty agent view**. The kind has to reach the caller, because the
   * caller is what routes the two destinations apart.
   */
  it('tells the caller which kind was pressed', () => {
    const info = {
      subagents: [sub({ toolUseId: 'a', agentType: 'Explore' }), sub({ toolUseId: 'b', description: 'check the deploy' })],
    } as unknown as SessionInfo
    const pressed: Array<[string, string]> = []
    const steps = sessionSteps(info, (toolUseId, kind) => pressed.push([toolUseId, kind]))
    for (const step of steps) {
      step.onSelect()
    }
    expect(pressed).toEqual([
      ['a', 'agent'],
      ['b', 'task'],
    ])
  })

  /**
   * Agents above tasks — the rows you can open are a block at the top, and the
   * markers are a tail you can skip. Stable *within* each group, because
   * dispatch order is the only order these records carry that means anything.
   */
  it('sorts agents above tasks without reordering either group', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 't1', description: 'first task' }),
        sub({ toolUseId: 'a1', agentType: 'Explore' }),
        sub({ toolUseId: 't2', description: 'second task' }),
        sub({ toolUseId: 'a2', agentType: 'fable' }),
      ],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {})
    expect(steps.map((s) => s.key)).toEqual(['a1', 'a2', 't1', 't2'])
  })

  it('splits agents from tasks, keeping the labels protocol spells', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 'a', agentType: 'Explore', description: 'find the auth check' }),
        sub({ toolUseId: 'b', description: 'check the deploy' }),
      ],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {})
    expect(steps.map((s) => s.kind)).toEqual(['agent', 'task'])
    expect(steps.map((s) => s.label)).toEqual(['Explore · find the auth check', 'check the deploy'])
  })
})
