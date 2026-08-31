import { describe, expect, it, vi } from 'vitest'
import { PendingRequestRegistry } from '../src/index.ts'

describe('PendingRequestRegistry', () => {
  it('settles a registered request with its value and provenance', async () => {
    const registry = new PendingRequestRegistry()
    const pending = registry.register<string>({ id: 'a', kind: 'tool_call' })
    expect(registry.size).toBe(1)
    expect(registry.settle('a', 'done')).toBe(true)
    await expect(pending).resolves.toEqual({ ok: true, value: 'done', settledBy: 'client' })
    expect(registry.size).toBe(0)
  })

  it('resolves (never rejects) on failure, so callers feed errors into the loop', async () => {
    const registry = new PendingRequestRegistry()
    const pending = registry.register<string>({ id: 'a', kind: 'execution' })
    registry.fail('a', 'orphaned', 'executor died')
    await expect(pending).resolves.toEqual({
      ok: false,
      reason: 'orphaned',
      error: 'executor died',
      settledBy: 'server',
    })
  })

  it('times out on its own and reports settledBy: timeout', async () => {
    const registry = new PendingRequestRegistry()
    const outcome = await registry.register<string>({ id: 'a', kind: 'approval', timeoutMs: 20 })
    expect(outcome).toMatchObject({ ok: false, reason: 'timeout', settledBy: 'timeout' })
    expect(registry.size).toBe(0)
  })

  it('is idempotent: a late or duplicate delivery cannot re-open a settled request', async () => {
    const registry = new PendingRequestRegistry()
    const pending = registry.register<string>({ id: 'a', kind: 'tool_call', timeoutMs: 20 })
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
    expect(registry.settle('a', 'too late')).toBe(false)
    expect(registry.fail('a', 'x', 'y')).toBe(false)
  })

  it('ignores unknown ids', () => {
    const registry = new PendingRequestRegistry()
    expect(registry.settle('nope', 1)).toBe(false)
    expect(registry.fail('nope', 'r', 'e')).toBe(false)
    expect(registry.get('nope')).toBeUndefined()
  })

  it('refuses to re-register a live id rather than stranding the first waiter', () => {
    const registry = new PendingRequestRegistry()
    void registry.register({ id: 'a', kind: 'tool_call' })
    expect(() => registry.register({ id: 'a', kind: 'tool_call' })).toThrow(/already registered/)
  })

  it('clears its timer on settle so a late timer cannot fire', async () => {
    vi.useFakeTimers()
    try {
      const registry = new PendingRequestRegistry()
      const onSettle = vi.fn()
      const pending = registry.register<string>({ id: 'a', kind: 'tool_call', timeoutMs: 1000, onSettle })
      registry.settle('a', 'quick')
      await pending
      vi.advanceTimersByTime(5000)
      expect(onSettle).toHaveBeenCalledOnce()
      expect(onSettle.mock.calls[0]![0]).toMatchObject({ ok: true, value: 'quick' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks entries by kind and cancels them in bulk', async () => {
    const registry = new PendingRequestRegistry()
    const approval = registry.register({ id: 'ap', kind: 'approval', meta: { toolName: 'Read' } })
    const call = registry.register({ id: 'tc', kind: 'tool_call' })
    expect(registry.list('approval').map((e) => e.id)).toEqual(['ap'])
    expect(registry.get('ap')).toMatchObject({ kind: 'approval', meta: { toolName: 'Read' } })

    expect(registry.cancelAll('closed', 'session closed', 'approval')).toBe(1)
    await expect(approval).resolves.toMatchObject({ ok: false, reason: 'closed' })
    expect(registry.size).toBe(1)

    expect(registry.cancelAll('closed', 'session closed')).toBe(1)
    await expect(call).resolves.toMatchObject({ ok: false, reason: 'closed' })
    expect(registry.size).toBe(0)
  })

  it('records expiresAt so a rehydrating host knows the deadline', () => {
    const registry = new PendingRequestRegistry()
    void registry.register({ id: 'a', kind: 'execution', timeoutMs: 5000 })
    const entry = registry.get('a')!
    expect(entry.expiresAt).toBeGreaterThan(Date.now())
    void registry.register({ id: 'b', kind: 'execution' })
    expect(registry.get('b')!.expiresAt).toBeUndefined()
  })
})
