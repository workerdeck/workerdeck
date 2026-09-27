import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PermissionRequest, SessionEvent } from '@workerdeck/protocol'
import { QUESTIONS_DISABLED_MESSAGE, RunnerCore, approvalResolution, type ApprovalHandler } from '../src/lib/runner-core.ts'

function recorded(core: RunnerCore): SessionEvent[] {
  const events: SessionEvent[] = []
  core.subscribe((event) => events.push(event))
  return events
}

function request(id: string, toolUseId = `tool-${id}`): PermissionRequest {
  return { id, toolName: 'Bash', input: { command: 'ls' }, toolUseId }
}

function handler(log: string[], extra: Partial<ApprovalHandler> = {}): ApprovalHandler {
  return {
    respond: (decision, resolvedBy) => {
      log.push(`respond:${decision.behavior}:${resolvedBy}`)
      return approvalResolution(decision, resolvedBy)
    },
    after: (resolution) => log.push(`after:${resolution.behavior}`),
    ...extra,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RunnerCore', () => {
  it('numbers events, fans them out, and replays the log to a late subscriber', () => {
    const core = new RunnerCore()
    const live = recorded(core)
    core.emit({ type: 'session_error', message: 'one' })
    core.emit({ type: 'session_error', message: 'two' })

    expect(live.map((e) => e.seq)).toEqual([1, 2])
    expect(core.eventAt(2)).toMatchObject({ message: 'two' })
    const late: SessionEvent[] = []
    core.subscribe((event) => late.push(event), 1)
    expect(late.map((e) => e.seq)).toEqual([2])
  })

  it('runs the hooks in order: prepare, observe, fan-out, settled', () => {
    const order: string[] = []
    const core = new RunnerCore({
      hooks: {
        prepare: (body) => {
          order.push('prepare')
          return body.type === 'session_error' ? { ...body, message: 'prepared' } : body
        },
        observe: () => order.push('observe'),
        settled: () => order.push('settled'),
      },
    })
    core.subscribe((event) => order.push(`deliver:${(event as { message?: string }).message}`))
    core.emit({ type: 'session_error', message: 'raw' })
    expect(order).toEqual(['prepare', 'observe', 'deliver:prepared', 'settled'])
  })

  it('dedupes status on the (status, detail) pair and never leaves a terminal status', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    core.setStatus('idle')
    core.setStatus('idle')
    core.setStatus('idle', 'waiting')
    core.setStatus('failed')
    core.setStatus('running')
    expect(events.map((e) => (e as { status?: string; detail?: string }).detail ?? (e as { status?: string }).status)).toEqual([
      'idle',
      'waiting',
      'failed',
    ])
    expect(core.terminal).toBe(true)
  })

  it('lets holdStatus swallow a transition', () => {
    const core = new RunnerCore({ hooks: { holdStatus: (status) => status === 'idle' } })
    const events = recorded(core)
    core.setStatus('idle')
    core.setStatus('running')
    expect(events.map((e) => (e as { status?: string }).status)).toEqual(['running'])
  })

  it('close denies pending approvals by policy, then tears down, then announces the close once', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    const log: string[] = []
    core.requestApproval(request('a'), handler(log))
    const closed = core.close('client', () => log.push('teardown'))
    const again = core.close('client', () => log.push('teardown again'))

    expect([closed, again]).toEqual([true, false])
    expect(log).toEqual(['respond:deny:policy', 'after:deny', 'teardown'])
    expect(events.map((e) => e.type)).toEqual(['permission_requested', 'permission_resolved', 'session_closed', 'status_changed'])
    expect(events[1]).toMatchObject({ requestId: 'a', behavior: 'deny', resolvedBy: 'policy', message: 'Session closed' })
    expect(core.status).toBe('closed')
    expect(core.pendingCount).toBe(0)
  })

  it('close can leave approvals alone', () => {
    const core = new RunnerCore()
    const log: string[] = []
    core.requestApproval(request('a'), handler(log))
    core.close('server', undefined, { settleApprovals: false })
    expect(log).toEqual([])
  })

  it('fail reports the error, marks the session failed, and hands over to close', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    const reasons: string[] = []
    core.fail('boom', (reason) => {
      reasons.push(reason)
      core.close(reason)
    })
    core.fail('ignored', (reason) => reasons.push(reason))

    expect(reasons).toEqual(['error'])
    expect(events.map((e) => e.type)).toEqual(['session_error', 'status_changed', 'session_closed'])
    expect(core.status).toBe('failed')
  })

  it('resolves an approval once, from the client by default', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    const log: string[] = []
    core.requestApproval(request('a'), handler(log))
    expect(core.pendingApprovals.map((r) => r.id)).toEqual(['a'])

    expect(core.resolveApproval('a', { behavior: 'allow' })).toBe(true)
    expect(core.resolveApproval('a', { behavior: 'allow' })).toBe(false)
    expect(log).toEqual(['respond:allow:client', 'after:allow'])
    expect(events.at(-1)).toMatchObject({ type: 'permission_resolved', requestId: 'a', behavior: 'allow', resolvedBy: 'client' })
  })

  it('times an approval out as a deny from the timeout', () => {
    vi.useFakeTimers()
    const core = new RunnerCore()
    const events = recorded(core)
    const log: string[] = []
    core.requestApproval(request('a'), handler(log, { timeoutMs: 1000 }))
    vi.advanceTimersByTime(999)
    expect(core.pendingCount).toBe(1)
    vi.advanceTimersByTime(1)

    expect(core.pendingCount).toBe(0)
    expect(log).toEqual(['respond:deny:timeout', 'after:deny'])
    expect(events.at(-1)).toMatchObject({ behavior: 'deny', resolvedBy: 'timeout', message: 'Approval timed out' })
  })

  it('settles every approval in request order, and can skip the follow-up', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    const log: string[] = []
    core.requestApproval(request('a'), handler(log))
    core.requestApproval(request('b'), handler(log))
    core.settleAllApprovals({ behavior: 'deny', message: 'interrupted' }, 'client', false)

    expect(log).toEqual(['respond:deny:client', 'respond:deny:client'])
    expect(events.filter((e) => e.type === 'permission_resolved').map((e) => (e as { requestId: string }).requestId)).toEqual(['a', 'b'])
  })

  it('lets a handler rewrite the resolution it reports', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    core.requestApproval(request('a'), {
      respond: () => ({ behavior: 'deny', resolvedBy: 'policy', message: 'no plain accept' }),
    })
    core.resolveApproval('a', { behavior: 'allow' })
    expect(events.at(-1)).toMatchObject({ behavior: 'deny', resolvedBy: 'policy', message: 'no plain accept' })
  })

  it('finds a pending approval by request or by wire id', () => {
    const core = new RunnerCore()
    core.requestApproval(request('a', 'call-1'), { ...handler([]), wireId: 7 })
    core.requestApproval(request('b', 'call-2'), { ...handler([]), wireId: 8 })
    expect(core.findApproval((r) => r.toolUseId === 'call-2')).toBe('b')
    expect(core.findApproval((_r, wireId) => wireId === 7)).toBe('a')
    expect(core.findApproval(() => false)).toBeUndefined()
  })

  it('resolveByPolicy records the card and its policy verdict without a pending entry', () => {
    const core = new RunnerCore()
    const events = recorded(core)
    core.resolveByPolicy(request('q'), 'deny', QUESTIONS_DISABLED_MESSAGE)
    core.resolveByPolicy(request('r'), 'allow')

    expect(core.pendingCount).toBe(0)
    expect(events.map((e) => e.type)).toEqual([
      'permission_requested',
      'permission_resolved',
      'permission_requested',
      'permission_resolved',
    ])
    expect(events[1]).toMatchObject({ behavior: 'deny', resolvedBy: 'policy', message: QUESTIONS_DISABLED_MESSAGE })
    expect(events[3]).not.toHaveProperty('message')
  })
})
