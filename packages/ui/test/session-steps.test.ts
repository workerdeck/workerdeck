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
  it('splits agents from tasks, keeping the labels protocol spells', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 'a', agentType: 'Explore', description: 'find the auth check' }),
        sub({ toolUseId: 'b', description: 'check the deploy' }),
      ],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {})
    expect(steps.map((s) => s.kind)).toEqual(['agent', 'task'])
    expect(steps.map((s) => s.label)).toEqual([
      'Explore · find the auth check',
      'check the deploy',
    ])
  })
})
