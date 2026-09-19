import { describe, expect, it } from 'vitest'
import { type ByModel, type TokenUsage, emptyTokenUsage } from '@workerdeck/protocol'
import { CostLedger } from '../src/lib/cost-ledger.ts'

function opus(input: number): ByModel {
  return { 'claude-opus-5': { ...emptyTokenUsage(), input } }
}

function tokens(model: string, fields: Partial<TokenUsage>): ByModel {
  return { [model]: { ...emptyTokenUsage(), ...fields } }
}

describe('CostLedger', () => {
  it('reports nothing before any engine has said anything', () => {
    const ledger = new CostLedger()
    expect(ledger.byModel).toBeUndefined()
    expect(ledger.costUsd).toBeUndefined()
    expect(ledger.reportedCostUsd).toBeUndefined()
  })

  it('replaces rather than sums a cumulative reading, which is what an engine process reports', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(opus(1_000_000), 4)
    ledger.observeCumulative(opus(3_000_000), 12)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(3_000_000)
    expect(ledger.reportedCostUsd).toBe(12)
    expect(ledger.costUsd).toBeCloseTo(15)
  })

  it('sums a per-turn delta, which is what the engines without a cumulative reading report', () => {
    const ledger = new CostLedger()
    ledger.observeDelta(opus(1_000_000))
    ledger.observeDelta(opus(2_000_000))
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(3_000_000)
  })

  it('adds a carried baseline to the new process rather than being overwritten by it', () => {
    const ledger = new CostLedger()
    ledger.carry({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.observeCumulative(opus(1_000_000), 4)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(6_000_000)
    expect(ledger.reportedCostUsd).toBe(24)
  })

  it('keeps the carried total visible before the woken process has reported anything', () => {
    const ledger = new CostLedger()
    ledger.carry({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    expect(ledger.reportedCostUsd).toBe(20)
    expect(ledger.costUsd).toBeCloseTo(25)
  })

  it('folds the current lifetime into the baseline on a rollover, so a context clear does not erase spend', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(opus(2_000_000), 8)
    ledger.rollover()
    ledger.observeCumulative(opus(1_000_000), 3)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(3_000_000)
    expect(ledger.reportedCostUsd).toBe(11)
  })

  it('treats every reading after a context clear as new spend, because the engine counts from zero again', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(opus(2_000_000), 8)
    ledger.rollover()
    ledger.observeCumulative(opus(3_000_000), 12)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(5_000_000)
    expect(ledger.reportedCostUsd).toBe(20)
  })

  it('does not double-count a rollover followed by a rebuild carrying the same snapshot', () => {
    const first = new CostLedger()
    first.observeCumulative(opus(2_000_000), 8)
    const second = new CostLedger()
    second.carry(first.snapshot())
    expect(second.reportedCostUsd).toBe(8)
    expect(second.byModel?.['claude-opus-5']?.input).toBe(2_000_000)
  })

  it('withholds a computed cost when no model in scope carried a rate, rather than reporting zero', () => {
    const ledger = new CostLedger()
    ledger.observeDelta({ 'model-nobody-priced': { ...emptyTokenUsage(), input: 1_000_000 } })
    expect(ledger.costUsd).toBeUndefined()
    expect(ledger.breakdown.unpriced).toBe(true)
  })

  it('carries a baseline with no reported cost without claiming one was reported', () => {
    const ledger = new CostLedger()
    ledger.carry({ byModel: opus(1_000_000) })
    expect(ledger.reportedCostUsd).toBeUndefined()
    expect(ledger.costUsd).toBeCloseTo(5)
  })

  it('names the share the live process reported as the lifetime of a snapshot', () => {
    const ledger = new CostLedger()
    ledger.observeCumulative(opus(2_000_000), 8)
    ledger.rollover()
    ledger.observeCumulative(opus(1_000_000), 3)
    expect(ledger.snapshot()).toEqual({
      byModel: opus(3_000_000),
      reportedCostUsd: 11,
      lifetime: { byModel: opus(1_000_000), reportedCostUsd: 3 },
    })
  })

  it('drops a carried baseline the woken process already restored, instead of counting it twice', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.observeCumulative(opus(6_000_000), 24)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(6_000_000)
    expect(ledger.reportedCostUsd).toBe(24)
  })

  it('adds the carried baseline when the woken process counts from zero', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.observeCumulative(opus(1_000_000), 4)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(6_000_000)
    expect(ledger.reportedCostUsd).toBe(24)
  })

  it('shows the carried total while the decision is still pending', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(5_000_000)
    expect(ledger.reportedCostUsd).toBe(20)
  })

  it('decides once: a later reading that grows past the baseline does not absorb it after the fact', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.observeCumulative(opus(1_000_000), 4)
    ledger.observeCumulative(opus(7_000_000), 28)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(12_000_000)
    expect(ledger.reportedCostUsd).toBe(48)
  })

  it('reads a first turn that outspends the whole baseline on every field as a restore, the one shape the figures cannot tell apart', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(1_000_000), reportedCostUsd: 4 })
    ledger.observeCumulative(opus(3_000_000), 12)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(3_000_000)
    expect(ledger.reportedCostUsd).toBe(12)
  })

  it('keeps the baseline when the first turn is bigger in total but not on every token field', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: tokens('claude-opus-5', { input: 100_000, cacheRead: 2_000_000 }), reportedCostUsd: 1 })
    ledger.observeCumulative(tokens('claude-opus-5', { input: 3_000_000 }), 15)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(3_100_000)
    expect(ledger.byModel?.['claude-opus-5']?.cacheRead).toBe(2_000_000)
    expect(ledger.reportedCostUsd).toBe(16)
  })

  it('keeps the baseline when a model it spent on is missing from the first reading', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: { ...opus(1_000_000), ...tokens('claude-haiku-4-5', { input: 500_000 }) }, reportedCostUsd: 5.5 })
    ledger.observeCumulative(opus(4_000_000), 20)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(5_000_000)
    expect(ledger.byModel?.['claude-haiku-4-5']?.input).toBe(500_000)
    expect(ledger.reportedCostUsd).toBe(25.5)
  })

  it('matches a restored model by its canonical id, since a resumed process keys a model it has not priced yet by the dated id', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: tokens('claude-haiku-4-5', { input: 500_000 }), reportedCostUsd: 0.5 })
    ledger.observeCumulative({ ...tokens('claude-haiku-4-5-20251001', { input: 500_000 }), ...opus(1_000_000) }, 5.5)
    expect(ledger.reportedCostUsd).toBe(5.5)
    expect(ledger.byModel?.['claude-haiku-4-5']).toBeUndefined()
    expect(ledger.byModel?.['claude-haiku-4-5-20251001']?.input).toBe(500_000)
  })

  it('lets a zeroed crash result through without deciding, so the first real reading still can', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.observeCumulative(undefined, 0)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(5_000_000)
    expect(ledger.reportedCostUsd).toBe(20)
    ledger.observeCumulative(opus(6_000_000), 24)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(6_000_000)
    expect(ledger.reportedCostUsd).toBe(24)
  })

  it('decides on the reported total alone when the persisted state has no token figures', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ reportedCostUsd: 20 })
    ledger.observeCumulative(opus(6_000_000), 24)
    expect(ledger.reportedCostUsd).toBe(24)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(6_000_000)
  })

  it('reconciles only the lifetime share when the state says which share that is, so spend from before a clear is never at stake', () => {
    const before = new CostLedger()
    before.observeCumulative(opus(5_000_000), 20)
    before.rollover()
    before.observeCumulative(opus(1_000_000), 4)
    const after = new CostLedger()
    after.carryUnlessRestored(before.snapshot())
    after.observeCumulative(opus(1_500_000), 6)
    expect(after.byModel?.['claude-opus-5']?.input).toBe(6_500_000)
    expect(after.reportedCostUsd).toBe(26)
  })

  it('keeps the whole state when the lifetime share is not restored either', () => {
    const before = new CostLedger()
    before.observeCumulative(opus(5_000_000), 20)
    before.rollover()
    before.observeCumulative(opus(1_000_000), 4)
    const after = new CostLedger()
    after.carryUnlessRestored(before.snapshot())
    after.observeCumulative(opus(200_000), 1)
    expect(after.byModel?.['claude-opus-5']?.input).toBe(6_200_000)
    expect(after.reportedCostUsd).toBe(25)
  })

  it('leaves a wake that counted from zero as a lifetime the next wake can reconcile against', () => {
    const first = new CostLedger()
    first.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    first.observeCumulative(opus(1_000_000), 4)
    const second = new CostLedger()
    second.carryUnlessRestored(first.snapshot())
    second.observeCumulative(opus(1_500_000), 6)
    expect(second.byModel?.['claude-opus-5']?.input).toBe(6_500_000)
    expect(second.reportedCostUsd).toBe(26)
  })

  it('keeps a pending baseline across a context clear, which the engine can no longer restore', () => {
    const ledger = new CostLedger()
    ledger.carryUnlessRestored({ byModel: opus(5_000_000), reportedCostUsd: 20 })
    ledger.rollover()
    ledger.observeCumulative(opus(6_000_000), 24)
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(11_000_000)
    expect(ledger.reportedCostUsd).toBe(44)
  })

  it('stays purely additive on carry, ignoring the lifetime share, for an engine that reports deltas', () => {
    const ledger = new CostLedger()
    ledger.carry({ byModel: opus(6_000_000), reportedCostUsd: 24, lifetime: { byModel: opus(1_000_000), reportedCostUsd: 4 } })
    ledger.observeDelta(opus(1_000_000))
    expect(ledger.byModel?.['claude-opus-5']?.input).toBe(7_000_000)
    expect(ledger.reportedCostUsd).toBe(24)
  })
})
