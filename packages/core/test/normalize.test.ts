import { describe, expect, it } from 'vitest'
import { rateLimitEventsFromUsage } from '../src/normalize.ts'

describe('rateLimitEventsFromUsage', () => {
  it('turns the plan windows into rate_limit events', () => {
    const events = rateLimitEventsFromUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 18, resets_at: '2026-08-05T12:00:00.000Z' },
        seven_day: { utilization: 61, resets_at: null },
        model_scoped: [{ display_name: 'Fable', utilization: 94 }],
      },
    })
    expect(events).toEqual([
      {
        type: 'rate_limit',
        info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 18,
          resetsAt: Date.parse('2026-08-05T12:00:00.000Z') / 1000,
        },
      },
      { type: 'rate_limit', info: { status: 'allowed', rateLimitType: 'seven_day', utilization: 61 } },
      // Per-model buckets are keyed under the weekly prefix, so a client grouping
      // on it keeps them with the other weekly windows.
      {
        type: 'rate_limit',
        info: { status: 'allowed', rateLimitType: 'seven_day_fable', utilization: 94 },
      },
    ])
  })

  it('reports nothing rather than zero for a window with no utilization', () => {
    // An API-key session has no plan limits at all; a window the CLI knows about
    // but has no number for is unknown, and 0% would read as "plenty left".
    expect(rateLimitEventsFromUsage({ rate_limits_available: false, rate_limits: null })).toEqual([])
    expect(rateLimitEventsFromUsage({})).toEqual([])
    expect(
      rateLimitEventsFromUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null }, seven_day: null },
      }),
    ).toEqual([])
  })

  it('does not list a per-model bucket twice under a name it already emitted', () => {
    const events = rateLimitEventsFromUsage({
      rate_limits_available: true,
      rate_limits: {
        seven_day_opus: { utilization: 40 },
        model_scoped: [{ display_name: 'Opus', utilization: 40 }],
      },
    })
    expect(events.map((e) => e.type === 'rate_limit' && e.info.rateLimitType)).toEqual([
      'seven_day_opus',
    ])
  })
})
