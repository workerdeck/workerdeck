import { describe, expect, it } from 'vitest'
import { parseTodoWriteInput, sessionTasks, taskCountLabel, taskSummary, visibleTasks } from '@workerdeck/protocol'
import type { ChecklistItem, SessionInfo, SubagentInfo } from '@workerdeck/protocol'

function todo(status: 'pending' | 'in_progress' | 'completed', content: string, activeForm?: string) {
  return activeForm === undefined ? { content, status } : { content, status, activeForm }
}

function sub(over: Partial<SubagentInfo>): SubagentInfo {
  return { toolUseId: 't1', status: 'running', startedAt: 0, toolCount: 0, ...over }
}

function info(over: Partial<Pick<SessionInfo, 'checklist' | 'subagents'>>): Pick<SessionInfo, 'checklist' | 'subagents'> {
  return { ...over }
}

describe('parseTodoWriteInput', () => {
  it('accepts a well-formed list and keeps its order', () => {
    expect(parseTodoWriteInput({ todos: [todo('completed', 'a'), todo('in_progress', 'b'), todo('pending', 'c')] })).toEqual([
      { status: 'completed', text: 'a' },
      { status: 'in_progress', text: 'b' },
      { status: 'pending', text: 'c' },
    ])
  })

  it('prefers activeForm for the in-progress entry only', () => {
    const items = parseTodoWriteInput({
      todos: [todo('in_progress', 'Fix the bug', 'Fixing the bug'), todo('completed', 'Read the file', 'Reading the file')],
    })
    expect(items?.map((item) => item.text)).toEqual(['Fixing the bug', 'Read the file'])
  })

  it('falls back to content when activeForm is blank or missing', () => {
    expect(parseTodoWriteInput({ todos: [todo('in_progress', 'Fix the bug', '  ')] })?.[0]?.text).toBe('Fix the bug')
    expect(parseTodoWriteInput({ todos: [todo('in_progress', 'Fix the bug')] })?.[0]?.text).toBe('Fix the bug')
  })

  it('reads a well-formed empty list as a clear, not as malformed', () => {
    expect(parseTodoWriteInput({ todos: [] })).toEqual([])
  })

  it('rejects anything that is not a todos array', () => {
    expect(parseTodoWriteInput(undefined)).toBeUndefined()
    expect(parseTodoWriteInput(null)).toBeUndefined()
    expect(parseTodoWriteInput('todos')).toBeUndefined()
    expect(parseTodoWriteInput({})).toBeUndefined()
    expect(parseTodoWriteInput({ todos: 'soon' })).toBeUndefined()
  })

  it('rejects the whole list when one entry is malformed', () => {
    expect(parseTodoWriteInput({ todos: [todo('pending', 'ok'), 'partial'] })).toBeUndefined()
    expect(parseTodoWriteInput({ todos: [todo('pending', 'ok'), { content: 'no status' }] })).toBeUndefined()
    expect(parseTodoWriteInput({ todos: [todo('pending', 'ok'), { content: '', status: 'pending' }] })).toBeUndefined()
    expect(parseTodoWriteInput({ todos: [todo('pending', 'ok'), { content: 7, status: 'pending' }] })).toBeUndefined()
    expect(parseTodoWriteInput({ todos: [{ content: 'ok', status: 'paused' }] })).toBeUndefined()
  })
})

describe('sessionTasks', () => {
  const checklist: ChecklistItem[] = [
    { text: 'read', status: 'completed' },
    { text: 'write', status: 'in_progress' },
    { text: 'ship', status: 'pending' },
  ]

  it('maps a checklist status onto a task state', () => {
    expect(sessionTasks(info({ checklist })).map((t) => t.state)).toEqual(['done', 'running', 'pending'])
  })

  it('puts the checklist first and the spawns after, in order', () => {
    const tasks = sessionTasks(
      info({
        checklist: [{ text: 'plan', status: 'pending' }],
        subagents: [sub({ toolUseId: 's1', description: 'one' }), sub({ toolUseId: 's2', description: 'two' })],
      }),
    )
    expect(tasks.map((t) => t.key)).toEqual(['checklist:0', 'spawn:s1', 'spawn:s2'])
  })

  it('excludes records that carry an agent type — those are sub-agents, not tasks', () => {
    const tasks = sessionTasks(
      info({ subagents: [sub({ toolUseId: 'a', agentType: 'Explore' }), sub({ toolUseId: 't', description: 'a task' })] }),
    )
    expect(tasks.map((t) => t.key)).toEqual(['spawn:t'])
  })

  it('keys duplicate checklist texts apart', () => {
    const tasks = sessionTasks(
      info({
        checklist: [
          { text: 'Run tests', status: 'pending' },
          { text: 'Run tests', status: 'pending' },
        ],
      }),
    )
    expect(new Set(tasks.map((t) => t.key)).size).toBe(2)
  })

  it('carries a spawn tool count as detail and a checklist item none', () => {
    const tasks = sessionTasks(
      info({ checklist: [{ text: 'plan', status: 'pending' }], subagents: [sub({ toolUseId: 's', toolCount: 4 })] }),
    )
    expect(tasks.map((t) => t.detail)).toEqual([undefined, '4'])
  })

  it('labels an untyped record with no description at all', () => {
    expect(sessionTasks(info({ subagents: [sub({ toolUseId: 's' })] }))[0]?.label).toBe('Task')
  })

  it('is empty when nothing is present', () => {
    expect(sessionTasks(info({}))).toEqual([])
  })
})

describe('taskSummary', () => {
  it('counts done, running and failed apart, and does not call a failure progress', () => {
    const tasks = sessionTasks(
      info({
        checklist: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'in_progress' },
        ],
        subagents: [sub({ toolUseId: 'f', status: 'failed', description: 'broke' })],
      }),
    )
    expect(taskSummary(tasks)).toEqual({ total: 3, done: 1, running: 1, failed: 1 })
    expect(taskCountLabel(taskSummary(tasks))).toBe('1/3')
  })

  it('has no label to draw when there are no tasks', () => {
    expect(taskCountLabel(taskSummary([]))).toBeUndefined()
  })
})

describe('visibleTasks', () => {
  it('hides only completed tasks, and keeps a failure visible', () => {
    const tasks = sessionTasks(
      info({
        checklist: [
          { text: 'a', status: 'completed' },
          { text: 'b', status: 'pending' },
        ],
        subagents: [sub({ toolUseId: 'f', status: 'failed', description: 'broke' })],
      }),
    )
    expect(visibleTasks(tasks, false).map((t) => t.label)).toEqual(['b', 'broke'])
    expect(visibleTasks(tasks, true)).toHaveLength(3)
  })
})
