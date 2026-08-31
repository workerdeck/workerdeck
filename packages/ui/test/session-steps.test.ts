import { describe, expect, it } from 'vitest'
import { isAgentRecord } from '@workerdeck/protocol'
import type { SubagentInfo } from '@workerdeck/protocol'
import { sessionSteps } from '../src/components/agent/SessionSteps.tsx'
import type { SessionInfo } from '@workerdeck/protocol'

function sub(over: Partial<SubagentInfo>): SubagentInfo {
  return {
    toolUseId: 't1',
    status: 'running',
    startedAt: 0,
    toolCount: 0,
    ...over,
  }
}

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
