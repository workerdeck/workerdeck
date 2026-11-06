import { describe, expect, it } from 'vitest'
import { cardStatus, type SessionInfo } from '@workerdeck/protocol'

const base: SessionInfo = { id: 's', status: 'idle', cwd: '/w', createdAt: 0, lastSeq: 0, pendingPermissionCount: 0 }

describe('cardStatus', () => {
  const full: SessionInfo = {
    ...base,
    statusLabel: { text: 'waiting on CI', emoji: '⏳', setAt: 0 },
    checklist: [
      { text: 'Plan', status: 'completed' },
      { text: 'Wire the badge', status: 'in_progress' },
    ],
    title: 'Member rows',
  }

  it('falls back label, then task in progress, then title, then state', () => {
    expect(cardStatus(full)).toEqual({ text: '⏳ waiting on CI', source: 'label' })
    expect(cardStatus({ ...full, statusLabel: undefined })).toEqual({ text: 'Wire the badge', source: 'task' })
    expect(cardStatus({ ...full, statusLabel: undefined, checklist: [] })).toEqual({ text: 'Member rows', source: 'title' })
    expect(cardStatus(base)).toEqual({ text: 'Idle', source: 'state' })
  })

  it('puts an unmet goal between the label and the task', () => {
    const goal = { text: 'tests green', state: 'active', setAt: 0, setBy: { kind: 'human' } } as const
    expect(cardStatus({ ...full, goal })).toEqual({ text: '⏳ waiting on CI', source: 'label' })
    expect(cardStatus({ ...full, statusLabel: undefined, goal })).toEqual({ text: '🎯 tests green', source: 'goal' })
    expect(cardStatus({ ...full, statusLabel: undefined, goal: { ...goal, state: 'paused' } }).text).toBe('🎯 Goal paused')
    expect(cardStatus({ ...full, statusLabel: undefined, goal: { ...goal, state: 'limited', limit: 'budget' } }).text).toBe(
      '🎯 Goal stopped',
    )
    expect(cardStatus({ ...full, statusLabel: undefined, goal: { ...goal, state: 'met' } }).source).toBe('task')
  })

  it('words the state', () => {
    expect(cardStatus({ ...base, engineAsleep: true }).text).toBe('Asleep')
    expect(cardStatus({ ...base, status: 'starting' }).text).toBe('Starting…')
    expect(cardStatus({ ...base, status: 'running' }).text).toBe('Working…')
    expect(cardStatus({ ...base, pendingPermissionCount: 1 }).text).toBe('Waiting for you')
    expect(cardStatus({ ...base, status: 'failed' }).text).toBe('Failed')
  })
})
