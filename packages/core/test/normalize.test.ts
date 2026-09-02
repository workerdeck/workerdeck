import { describe, expect, it } from 'vitest'
import { modelOptionsFromSdk, rateLimitEventsFromUsage } from '../src/lib/normalize.ts'

describe('modelOptionsFromSdk', () => {
  const reported = [
    {
      value: 'default',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Default (recommended)',
      description: 'Opus 5 with 1M context',
    },
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Opus (1M context)',
    },
    { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1', displayName: 'Fable' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
    { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
  ]

  it("drops the CLI's 'default' row — it is a choice, not a model", () => {
    expect(modelOptionsFromSdk(reported).map((m) => m.value)).not.toContain('default')
  })

  it('names each row with its version, in capability order', () => {
    expect(modelOptionsFromSdk(reported).map((m) => m.displayName)).toEqual(['Fable 5.1', 'Opus 5', 'Sonnet 5', 'Haiku 4.5'])
  })

  it('marks the newest of each family primary and files older versions behind it', () => {
    const withOlder = [
      ...reported,
      { value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5', displayName: 'Fable 5' },
      { value: 'claude-opus-4-8', resolvedModel: 'claude-opus-4-8', displayName: 'Opus 4.8' },
      { value: 'claude-sonnet-4-6', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    ]
    const options = modelOptionsFromSdk(withOlder)
    expect(options.filter((m) => m.primary).map((m) => m.displayName)).toEqual(['Fable 5.1', 'Opus 5', 'Sonnet 5', 'Haiku 4.5'])
    expect(options.filter((m) => !m.primary).map((m) => m.displayName)).toEqual(['Fable 5', 'Opus 4.8', 'Sonnet 4.6'])
  })

  it("keeps the CLI's name when a derived one would be ambiguous", () => {
    const options = modelOptionsFromSdk([
      { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]', displayName: 'Opus (1M context)' },
      { value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' },
    ])
    expect(options.map((m) => m.displayName)).toEqual(['Opus (1M context)', 'Opus'])
  })

  it('carries resolvedModel through, which is what matches a running session', () => {
    expect(modelOptionsFromSdk(reported).find((m) => m.displayName === 'Opus 5')).toMatchObject({
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5[1m]',
    })
  })

  it('leaves an unrecognised id alone, and visible', () => {
    const options = modelOptionsFromSdk([{ value: 'internal-preview', displayName: 'Preview' }])
    expect(options).toEqual([
      {
        value: 'internal-preview',
        resolvedModel: undefined,
        displayName: 'Preview',
        description: undefined,
        primary: true,
      },
    ])
  })
})

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
      {
        type: 'rate_limit',
        info: { status: 'allowed', rateLimitType: 'seven_day_fable', utilization: 94 },
      },
    ])
  })

  it('reports nothing rather than zero for a window with no utilization', () => {
    // A window the CLI names but has no number for is unknown; 0% would read as "plenty left".
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
    expect(events.map((e) => e.type === 'rate_limit' && e.info.rateLimitType)).toEqual(['seven_day_opus'])
  })
})
