import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, SessionInfo } from '@workerdeck/protocol'
import { driveLiveActivities, type ActivityRunner, type ActivityTarget } from '../src/apns/live-activities.ts'
import type { ActivityAttributes, ActivityContentState } from '../src/apns/live-activity.ts'

type Sent =
  | { kind: 'start'; attributes: ActivityAttributes; state: ActivityContentState }
  | { kind: 'update'; sessionId: string; state: ActivityContentState; urgent: boolean }
  | { kind: 'end'; sessionId: string; state: ActivityContentState }

function recorder(): { target: ActivityTarget; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    target: {
      start: (attributes, state) => void sent.push({ kind: 'start', attributes, state }),
      update: (sessionId, state, { urgent }) => void sent.push({ kind: 'update', sessionId, state, urgent }),
      end: (sessionId, state) => void sent.push({ kind: 'end', sessionId, state }),
    },
  }
}

function fakeRunner(id = 'ses_1') {
  let info: SessionInfo = {
    id,
    status: 'idle',
    cwd: '/Users/t/projects/ai/workerdeck',
    engine: 'claude',
    createdAt: 0,
    lastSeq: 1,
    pendingPermissionCount: 0,
  }
  let pending: PermissionRequest[] = []
  const listeners = new Set<(event: { type: string }) => void>()

  const runner: ActivityRunner = {
    id,
    info: () => info,
    get pendingApprovals() {
      return pending
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }

  return {
    runner,
    emit(type: string, changes: Partial<SessionInfo> = {}, approvals?: PermissionRequest[]) {
      info = { ...info, ...changes, lastSeq: info.lastSeq + 1 }
      if (approvals !== undefined) {
        pending = approvals
      }
      for (const listener of listeners) {
        listener({ type })
      }
    },
  }
}

function source(...runners: ActivityRunner[]) {
  return {
    observe(listener: (runner: ActivityRunner) => void) {
      for (const runner of runners) {
        listener(runner)
      }
      return () => {}
    },
  }
}

const REQUEST: PermissionRequest = { id: 'req_1', toolName: 'Bash', toolUseId: 'tu_1', input: { command: 'ls' } }

describe('live activity driver', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('swallows the running flash a session emits while starting up', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    // What `system_init` does: running, then idle before anyone could have read it.
    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(1_500)
    emit('status_changed', { status: 'idle' })
    vi.advanceTimersByTime(60_000)
    expect(sent).toEqual([])
  })

  it('raises a card once the turn is still running after the debounce', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    expect(sent).toEqual([])
    vi.advanceTimersByTime(2_000)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('start')
    expect(sent[0]!.state.phase).toBe('running')
  })

  it('raises an approval immediately, because that is the whole point of the card', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('permission_requested', { status: 'awaiting_approval', pendingPermissionCount: 1 }, [REQUEST])
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind).toBe('start')
    expect(sent[0]!.state.phase).toBe('approval')
  })

  it('holds the card through a quick follow-up prompt instead of ending and starting again', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)
    emit('turn_result', { status: 'idle' })
    vi.advanceTimersByTime(5_000)
    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(60_000)
    expect(sent.filter((one) => one.kind === 'end')).toEqual([])
    expect(sent.filter((one) => one.kind === 'start')).toHaveLength(1)
  })

  it('ends after the grace once the session really has settled', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)
    emit('turn_result', { status: 'idle' })
    vi.advanceTimersByTime(20_000)
    const last = sent.at(-1)!
    expect(last.kind).toBe('end')
    expect(last.state.phase).toBe('done')
  })

  it('ends at once when the session parks, fails or closes', () => {
    for (const [status, phase] of [
      ['parked', 'parked'],
      ['failed', 'failed'],
      ['closed', 'ended'],
    ] as const) {
      const { runner, emit } = fakeRunner()
      const { target, sent } = recorder()
      driveLiveActivities({ source: source(runner), target })
      emit('status_changed', { status: 'running' })
      vi.advanceTimersByTime(2_000)
      emit('status_changed', { status })
      const last = sent.at(-1)!
      expect(last.kind, status).toBe('end')
      expect(last.state.phase, status).toBe(phase)
    }
  })

  it('pushes a new request at priority 10 and a checklist tick at leisure', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)

    emit('checklist', { checklist: [{ text: 'one', status: 'in_progress' }] })
    expect(sent.filter((one) => one.kind === 'update')).toEqual([])
    vi.advanceTimersByTime(30_000)
    const progress = sent.find((one) => one.kind === 'update')
    expect(progress).toMatchObject({ urgent: false })

    emit('permission_requested', { status: 'awaiting_approval', pendingPermissionCount: 1 }, [REQUEST])
    expect(sent.at(-1)).toMatchObject({ kind: 'update', urgent: true, state: { phase: 'approval' } })
  })

  it('says nothing when nothing a card can draw has changed', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)
    const after = sent.length
    // A tool the card does not draw still fires an event. Hashing the projection is what keeps
    // that from becoming a push.
    emit('checklist', {})
    vi.advanceTimersByTime(60_000)
    expect(sent.filter((one) => one.kind === 'update' && one.urgent)).toEqual([])
    expect(sent.length).toBe(after)
  })

  it('keeps the card alive past the system’s update ceiling by renewing it', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)
    vi.advanceTimersByTime(7 * 60 * 60 * 1000 + 45 * 60 * 1000)

    const kinds = sent.map((one) => one.kind)
    expect(kinds).toContain('end')
    expect(kinds.lastIndexOf('start')).toBeGreaterThan(kinds.indexOf('end'))
  })

  it('refreshes the stale date on a turn that is only thinking', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    vi.advanceTimersByTime(2_000)
    const after = sent.length
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(sent.length).toBeGreaterThan(after)
    expect(sent.at(-1)).toMatchObject({ urgent: false })
  })

  it('picks up a session that was already engaged when the driver attached', () => {
    const { runner, emit } = fakeRunner()
    emit('status_changed', { status: 'awaiting_approval', pendingPermissionCount: 1 }, [REQUEST])
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(runner), target })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.state.phase).toBe('approval')
  })

  it('tracks two sessions without confusing their cards', () => {
    const one = fakeRunner('ses_1')
    const two = fakeRunner('ses_2')
    const { target, sent } = recorder()
    driveLiveActivities({ source: source(one.runner, two.runner), target })

    one.emit('status_changed', { status: 'running' })
    two.emit('permission_requested', { status: 'awaiting_approval', pendingPermissionCount: 1 }, [REQUEST])
    vi.advanceTimersByTime(2_000)

    const starts = sent.filter((entry) => entry.kind === 'start')
    expect(starts.map((entry) => entry.attributes.sessionId).sort()).toEqual(['ses_1', 'ses_2'])
  })

  it('stops everything when the driver is torn down', () => {
    const { runner, emit } = fakeRunner()
    const { target, sent } = recorder()
    const stop = driveLiveActivities({ source: source(runner), target })

    emit('status_changed', { status: 'running' })
    stop()
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(sent).toEqual([])
  })
})
