import { describe, expect, it } from 'vitest'
import {
  type ByModel,
  DEFAULT_PRICING,
  UNPRICED_WARN_SHARE,
  addTokenUsage,
  canonicalModel,
  costOf,
  costOfByModel,
  emptyTokenUsage,
  mergeByModel,
  meteredCost,
  rateFor,
  subscriptionComparison,
  tokenUsageFromWire,
  totalTokens,
  unpricedModels,
} from '@workerdeck/protocol'

describe('canonicalModel', () => {
  it('strips a context marker, a date snapshot and a provider prefix', () => {
    expect(canonicalModel('claude-opus-5[1m]')).toBe('claude-opus-5')
    expect(canonicalModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
    expect(canonicalModel('claude-sonnet-4-5@20250929')).toBe('claude-sonnet-4-5')
    expect(canonicalModel('us.anthropic.claude-opus-5')).toBe('claude-opus-5')
    expect(canonicalModel('anthropic/claude-opus-5')).toBe('claude-opus-5')
    expect(canonicalModel('openai/gpt-5.6-sol')).toBe('gpt-5.6-sol')
  })

  it('leaves a model that differs only by suffix distinct', () => {
    expect(canonicalModel('gpt-5.6-luna')).not.toBe(canonicalModel('gpt-5.6-sol'))
  })
})

describe('rateFor', () => {
  it('derives anthropic cache tiers off base input', () => {
    const rate = rateFor('claude-opus-5')
    expect(rate).toEqual({ input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 })
  })

  it('honours the fable flat cache-read rate rather than the 0.1x ladder', () => {
    expect(rateFor('claude-fable-5-1')?.cacheRead).toBe(0.25)
    expect(rateFor('claude-fable-5')?.cacheRead).toBe(1)
  })

  it('prices an openai cache write at plain input, since there is no write premium', () => {
    const rate = rateFor('gpt-5.6-sol')
    expect(rate?.cacheWrite5m).toBe(4)
    expect(rate?.cacheWrite1h).toBe(4)
    expect(rate?.cacheRead).toBe(0.4)
  })

  it('returns undefined for an unknown model rather than a default rate', () => {
    expect(rateFor('some-model-nobody-priced')).toBeUndefined()
    expect(rateFor(undefined)).toBeUndefined()
  })
})

describe('costOf', () => {
  it('prices each token kind at its own rate', () => {
    const cost = costOf(
      { input: 1_000_000, output: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, cacheRead: 1_000_000 },
      'claude-opus-5',
    )
    expect(cost.input).toBeCloseTo(5)
    expect(cost.output).toBeCloseTo(25)
    expect(cost.cacheWrite).toBeCloseTo(16.25)
    expect(cost.cacheRead).toBeCloseTo(0.5)
    expect(cost.total).toBeCloseTo(46.75)
    expect(cost.unpriced).toBe(false)
  })

  it('reports an unknown model as unpriced with its whole token count, never a zero cost that looks real', () => {
    const cost = costOf({ input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1000 }, 'mystery-model')
    expect(cost.total).toBe(0)
    expect(cost.unpriced).toBe(true)
    expect(cost.unpricedTokens).toBe(1150)
    expect(cost.unpricedShare).toBe(1)
  })

  it('treats a cache read as an order of magnitude cheaper than fresh input', () => {
    const read = costOf({ ...emptyTokenUsage(), cacheRead: 1_000_000 }, 'claude-opus-5').total
    const fresh = costOf({ ...emptyTokenUsage(), input: 1_000_000 }, 'claude-opus-5').total
    expect(fresh / read).toBeCloseTo(10)
  })
})

describe('costOfByModel', () => {
  const mixed: ByModel = {
    'claude-opus-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    'mystery-model': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  }

  it('sums each model at its own rate', () => {
    const byModel: ByModel = {
      'claude-opus-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      'claude-haiku-4-5': { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
    }
    expect(costOfByModel(byModel).total).toBeCloseTo(6)
  })

  it('surfaces the unpriced share rather than understating silently', () => {
    const cost = costOfByModel(mixed)
    expect(cost.total).toBeCloseTo(5)
    expect(cost.unpriced).toBe(false)
    expect(cost.unpricedShare).toBeCloseTo(0.5)
    expect(cost.unpricedShare).toBeGreaterThan(UNPRICED_WARN_SHARE)
    expect(unpricedModels(mixed)).toEqual(['mystery-model'])
  })

  it('marks the whole breakdown unpriced when nothing in scope carried a rate', () => {
    const cost = costOfByModel({ 'mystery-model': { input: 10, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } })
    expect(cost.unpriced).toBe(true)
  })

  it('is not unpriced when there is simply nothing to price', () => {
    expect(costOfByModel({}).unpriced).toBe(false)
  })
})

describe('tokenUsageFromWire', () => {
  it('reads the claude-shaped aggregate every engine emits', () => {
    const usage = tokenUsageFromWire({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 })
    expect(usage).toEqual({ input: 10, output: 20, cacheWrite5m: 30, cacheWrite1h: 0, cacheRead: 40 })
  })

  it('prefers the explicit 5m/1h split when the engine provided one', () => {
    const usage = tokenUsageFromWire({
      input_tokens: 1,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    })
    expect(usage.cacheWrite5m).toBe(10)
    expect(usage.cacheWrite1h).toBe(20)
  })

  it('survives junk without inventing tokens', () => {
    expect(tokenUsageFromWire(undefined)).toEqual(emptyTokenUsage())
    expect(tokenUsageFromWire('nope')).toEqual(emptyTokenUsage())
    expect(tokenUsageFromWire({ input_tokens: -5, output_tokens: Number.NaN })).toEqual(emptyTokenUsage())
  })
})

describe('accumulation', () => {
  it('adds usage without mutating either operand', () => {
    const a = { input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 }
    const b = { input: 10, output: 20, cacheWrite5m: 30, cacheWrite1h: 40, cacheRead: 50 }
    expect(addTokenUsage(a, b)).toEqual({ input: 11, output: 22, cacheWrite5m: 33, cacheWrite1h: 44, cacheRead: 55 })
    expect(a.input).toBe(1)
  })

  it('merges per-model records model by model', () => {
    const base: ByModel = { 'claude-opus-5': { ...emptyTokenUsage(), input: 5 } }
    const add: ByModel = { 'claude-opus-5': { ...emptyTokenUsage(), input: 7 }, 'claude-haiku-4-5': { ...emptyTokenUsage(), output: 3 } }
    const merged = mergeByModel(base, add)
    expect(merged['claude-opus-5']?.input).toBe(12)
    expect(merged['claude-haiku-4-5']?.output).toBe(3)
    expect(base['claude-opus-5']?.input).toBe(5)
  })

  it('counts every token kind in the total', () => {
    expect(totalTokens({ input: 1, output: 2, cacheWrite5m: 3, cacheWrite1h: 4, cacheRead: 5 })).toBe(15)
  })
})

describe('meteredCost', () => {
  it('excludes cache reads, which a plan window does not meter', () => {
    const cost = costOf({ input: 1_000_000, output: 1_000_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 100_000_000 }, 'claude-opus-5')
    expect(meteredCost(cost)).toBeCloseTo(30)
    expect(cost.total).toBeGreaterThan(meteredCost(cost))
  })
})

describe('subscriptionComparison', () => {
  it('compares a week of spend against the weekly share of a monthly fee', () => {
    const result = subscriptionComparison(92.31, 200)
    expect(result?.weeklyShareUsd).toBeCloseTo(46.15, 1)
    expect(result?.ratio).toBeCloseTo(2, 1)
  })

  it('declines to compare against an unset fee', () => {
    expect(subscriptionComparison(10, 0)).toBeUndefined()
    expect(subscriptionComparison(10, Number.NaN)).toBeUndefined()
  })
})

describe('the bundled table', () => {
  it('prices every model the codex catalog can select', () => {
    for (const model of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2']) {
      expect(DEFAULT_PRICING[model], model).toBeDefined()
    }
  })

  it('never prices output below input', () => {
    for (const [model, rate] of Object.entries(DEFAULT_PRICING)) {
      expect(rate.output, model).toBeGreaterThanOrEqual(rate.input)
      expect(rate.cacheRead, model).toBeLessThan(rate.input)
    }
  })
})
