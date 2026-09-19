import { describe, expect, it } from 'vitest'
import type { Runner } from '@workerdeck/core'
import { type ByModel, type SessionEvent, type SessionInfo, emptyTokenUsage } from '@workerdeck/protocol'
import { SpendLedger, dayKey } from '../src/services/spend-ledger.ts'

function opus(input: number): ByModel {
  return { 'claude-opus-5': { ...emptyTokenUsage(), input } }
}

type FakeRunner = Runner & { emit: (usageByModel: ByModel, at?: number) => void }

function fakeRunner(id: string, profile: string | undefined, seeded?: ByModel): FakeRunner {
  const listeners = new Set<(event: SessionEvent) => void>()
  const info = { id, profile, usageByModel: seeded } as SessionInfo
  return {
    id,
    info: () => info,
    subscribe: (listener: (event: SessionEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (usageByModel: ByModel, at = Date.now()) => {
      for (const listener of listeners) {
        listener({ type: 'turn_result', usageByModel, ts: at, seq: 1 } as unknown as SessionEvent)
      }
    },
  } as unknown as FakeRunner
}

describe('SpendLedger', () => {
  it('banks the delta of a session-cumulative reading, not the reading itself', () => {
    const ledger = new SpendLedger()
    const runner = fakeRunner('s1', 'work')
    ledger.watch(runner)
    runner.emit(opus(1_000_000))
    runner.emit(opus(3_000_000))
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(15)
  })

  it('does not re-bank a woken session whose carried spend is already in the ledger', () => {
    const ledger = new SpendLedger()
    const woken = fakeRunner('s1', 'work', opus(5_000_000))
    ledger.watch(woken)
    woken.emit(opus(6_000_000))
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(5)
  })

  it('keeps two profiles apart', () => {
    const ledger = new SpendLedger()
    const a = fakeRunner('s1', 'work')
    const b = fakeRunner('s2', 'personal')
    ledger.watch(a)
    ledger.watch(b)
    a.emit(opus(1_000_000))
    b.emit(opus(2_000_000))
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(5)
    expect(ledger.spend('personal')?.weekUsd).toBeCloseTo(10)
  })

  it('ignores a session with no profile, which has no account to bill', () => {
    const ledger = new SpendLedger()
    const runner = fakeRunner('s1', undefined)
    ledger.watch(runner)
    runner.emit(opus(1_000_000))
    expect(ledger.spend('work')).toBeUndefined()
  })

  it('refuses a reading that went backwards rather than recording a negative day', () => {
    const ledger = new SpendLedger()
    const runner = fakeRunner('s1', 'work')
    ledger.watch(runner)
    runner.emit(opus(3_000_000))
    runner.emit(opus(1_000_000))
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(15)
  })

  it('leaves a day outside the window out of the weekly total but keeps it in the monthly one', () => {
    const ledger = new SpendLedger()
    const now = Date.now()
    const runner = fakeRunner('s1', 'work')
    ledger.watch(runner)
    runner.emit(opus(1_000_000), now - 20 * 86_400_000)
    runner.emit(opus(2_000_000), now)
    const spend = ledger.spend('work', now)
    expect(spend?.weekUsd).toBeCloseTo(5)
    expect(spend?.monthUsd).toBeCloseTo(10)
  })

  it('compares the week against the weekly share of a monthly fee when the operator set one', () => {
    const ledger = new SpendLedger({ monthlySubscriptionUsd: () => 200 })
    const runner = fakeRunner('s1', 'work')
    ledger.watch(runner)
    runner.emit({ 'claude-opus-5': { ...emptyTokenUsage(), output: 4_000_000 } })
    const spend = ledger.spend('work')
    expect(spend?.weekUsd).toBeCloseTo(100)
    expect(spend?.subscription?.ratio).toBeCloseTo(2.17, 1)
  })

  it('reports no spend for a profile that has never run a turn', () => {
    expect(new SpendLedger().spend('nobody')).toBeUndefined()
  })

  it('restores banked days from a store', async () => {
    const record = { days: { [dayKey(Date.now())]: { work: opus(2_000_000) } } }
    const ledger = new SpendLedger({ store: { load: async () => record, save: async () => {} } })
    await ledger.load()
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(10)
  })

  it('stops banking once the watch is detached', () => {
    const ledger = new SpendLedger()
    const runner = fakeRunner('s1', 'work')
    const detach = ledger.watch(runner)
    runner.emit(opus(1_000_000))
    detach()
    runner.emit(opus(9_000_000))
    expect(ledger.spend('work')?.weekUsd).toBeCloseTo(5)
  })
})
