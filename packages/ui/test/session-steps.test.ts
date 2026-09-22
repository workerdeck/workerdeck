import { describe, expect, it } from 'vitest'
import { isAgentRecord, visibleSubagents } from '@workerdeck/protocol'
import type { ShellInfo, SubagentInfo } from '@workerdeck/protocol'
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

  it('trusts an engine that marks the record an agent without naming it', () => {
    expect(isAgentRecord(sub({ isAgent: true }))).toBe(true)
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

  it('leaves untyped records out entirely - they are tasks, and tasks are not steps', () => {
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

  it('draws what the display preference asks for', () => {
    const info = {
      subagents: [
        sub({ toolUseId: 'run', agentType: 'Explore' }),
        sub({ toolUseId: 'done', agentType: 'Explore', status: 'done' }),
        sub({ toolUseId: 'bad', agentType: 'Explore', status: 'failed' }),
      ],
    } as unknown as SessionInfo
    expect(sessionSteps(info, () => {}, 'all').map((s) => s.key)).toEqual(['run', 'done', 'bad'])
    expect(sessionSteps(info, () => {}, 'active').map((s) => s.key)).toEqual(['run', 'bad'])
    expect(sessionSteps(info, () => {}, 'none')).toEqual([])
  })
})

function shell(over: Partial<ShellInfo>): ShellInfo {
  return {
    id: 's1',
    sessionId: 'sess',
    ordinal: 1,
    command: 'npm run dev',
    label: 'npm run dev',
    cwd: '/repo',
    owner: 'user',
    status: 'running',
    startedAt: 0,
    bytes: 0,
    cols: 80,
    rows: 24,
    ...over,
  }
}

describe('sessionSteps shells', () => {
  const opts = (over: Partial<Parameters<typeof sessionSteps>[3] & object> = {}) => ({ now: 10_000, onSelect: () => {}, ...over })

  it('draws no shells at all when the caller does not ask for them', () => {
    const info = { shells: [shell({})] } as unknown as SessionInfo
    expect(sessionSteps(info, () => {})).toEqual([])
  })

  it('puts shells after agents and keys them by shell id', () => {
    const info = {
      subagents: [sub({ toolUseId: 'a', agentType: 'Explore' })],
      shells: [shell({ id: 'sh1' })],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {}, 'all', opts())
    expect(steps.map((s) => s.key)).toEqual(['a', 'sh1'])
    expect(steps.map((s) => s.kind)).toEqual(['agent', 'shell'])
  })

  it('honours the promote debounce against the caller clock', () => {
    const info = { shells: [shell({ id: 'sh1', startedAt: 0 })] } as unknown as SessionInfo
    expect(sessionSteps(info, () => {}, 'all', opts({ now: 2999 }))).toEqual([])
    expect(sessionSteps(info, () => {}, 'all', opts({ now: 3000 })).map((s) => s.key)).toEqual(['sh1'])
  })

  it('reports the pressed shell to the caller', () => {
    const info = { shells: [shell({ id: 'sh1' }), shell({ id: 'sh2', ordinal: 2 })] } as unknown as SessionInfo
    const pressed: string[] = []
    for (const step of sessionSteps(info, () => {}, 'all', opts({ onSelect: (id: string) => pressed.push(id) }))) {
      step.onSelect()
    }
    expect(pressed).toEqual(['sh1', 'sh2'])
  })

  it('offers a kill only on a running shell, and only when the caller can kill', () => {
    const running = { shells: [shell({ id: 'sh1' })] } as unknown as SessionInfo
    const killed: string[] = []
    const withKill = sessionSteps(running, () => {}, 'all', opts({ onKill: (id: string) => killed.push(id) }))
    withKill[0]?.onKill?.()
    expect(killed).toEqual(['sh1'])
    expect(sessionSteps(running, () => {}, 'all', opts())[0]?.onKill).toBeUndefined()

    const failed = { shells: [shell({ id: 'sh1', status: 'exited', exitCode: 1, endedAt: 9000 })] } as unknown as SessionInfo
    expect(sessionSteps(failed, () => {}, 'all', opts({ onKill: () => {} }))[0]?.onKill).toBeUndefined()
  })

  it('spells the state and the detail from the shell record', () => {
    const info = {
      shells: [shell({ id: 'run' }), shell({ id: 'bad', ordinal: 2, status: 'exited', exitCode: 1, endedAt: 9000 })],
    } as unknown as SessionInfo
    const steps = sessionSteps(info, () => {}, 'all', opts())
    expect(steps.map((s) => s.state)).toEqual(['running', 'failed'])
    expect(steps.map((s) => s.detail)).toEqual([undefined, 'exit 1'])
  })

  it('never promotes a clean exit', () => {
    const info = { shells: [shell({ id: 'sh1', status: 'exited', exitCode: 0, endedAt: 9000 })] } as unknown as SessionInfo
    expect(sessionSteps(info, () => {}, 'all', opts())).toEqual([])
  })

  it('draws shells even when the display preference hides sub-agents', () => {
    const info = {
      subagents: [sub({ toolUseId: 'a', agentType: 'Explore' })],
      shells: [shell({ id: 'sh1' })],
    } as unknown as SessionInfo
    expect(sessionSteps(info, () => {}, 'none', opts()).map((s) => s.key)).toEqual(['sh1'])
  })
})

describe('visibleSubagents', () => {
  const info = {
    subagents: [sub({ toolUseId: 'run' }), sub({ toolUseId: 'done', status: 'done' }), sub({ toolUseId: 'bad', status: 'failed' })],
  } as unknown as SessionInfo

  it('keeps a failed record under active: it is not a completed one', () => {
    expect(visibleSubagents(info, 'active').map((s) => s.toolUseId)).toEqual(['run', 'bad'])
  })

  it('keeps every record under all, and none under none', () => {
    expect(visibleSubagents(info, 'all').map((s) => s.toolUseId)).toEqual(['run', 'done', 'bad'])
    expect(visibleSubagents(info, 'none')).toEqual([])
  })

  it('survives a session with no sub-agents at all', () => {
    expect(visibleSubagents({} as SessionInfo, 'all')).toEqual([])
  })
})
