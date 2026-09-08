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
  it('reports the pressed agent to the caller', () => {
    const info = {
      subagents: [sub({ toolUseId: 'a', agentType: 'Explore' }), sub({ toolUseId: 'b', agentType: 'fable' })],
    } as unknown as SessionInfo
    const pressed: string[] = []
    const steps = sessionSteps(info, (toolUseId) => pressed.push(toolUseId))
    for (const step of steps) {
      step.onSelect()
    }
    expect(pressed).toEqual(['a', 'b'])
  })

  it('leaves untyped records out entirely — they are tasks, and tasks are not steps', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 't1', description: 'first task' }),
        sub({ toolUseId: 'a1', agentType: 'Explore' }),
        sub({ toolUseId: 't2', description: 'second task' }),
        sub({ toolUseId: 'a2', agentType: 'fable' }),
      ],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {})
    expect(steps.map((s) => s.key)).toEqual(['a1', 'a2'])
  })

  it('keeps the labels protocol spells', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 'a', agentType: 'Explore', description: 'find the auth check' }),
        sub({ toolUseId: 'b', description: 'check the deploy' }),
      ],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {})
    expect(steps.map((s) => s.label)).toEqual(['Explore · find the auth check'])
  })

  it('has no steps at all when every record is untyped', () => {
    const info = { subagents: [sub({ toolUseId: 't1', description: 'a task' })] } as unknown as SessionInfo
    expect(sessionSteps(info, () => {})).toEqual([])
  })
})
