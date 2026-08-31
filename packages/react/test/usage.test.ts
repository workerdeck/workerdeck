import { describe, expect, it } from 'vitest'
import { mergeUsage, usageInfos } from '@workerdeck/protocol'
import type { ProfileUsage, RateLimitInfo } from '@workerdeck/protocol'

function info(utilization: number, extra: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    status: 'allowed',
    rateLimitType: 'five_hour',
    utilization,
    ...extra,
  }
}

describe('mergeUsage', () => {
  it('is empty when neither side has reported', () => {
    expect(mergeUsage({}, undefined)).toEqual({})
    expect(usageInfos(undefined)).toBeUndefined()
  })

  it("stands the session's own reading up when the gateway holds nothing", () => {
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) }, updatedAt: 1_000 }, undefined)
    expect(merged).toEqual({ five_hour: { info: info(40), updatedAt: 1_000 } })
  })

  it('prefers the profile reading over the session it came from', () => {
    const profile: ProfileUsage = { five_hour: { info: info(70), updatedAt: 5_000 } }
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) }, updatedAt: 1_000 }, profile)
    expect(merged.five_hour).toEqual({ info: info(70), updatedAt: 5_000 })
  })

  it('prefers the profile reading even when the session state looks newer', () => {
    const profile: ProfileUsage = { five_hour: { info: info(70), updatedAt: 5_000 } }
    const merged = mergeUsage({ rateLimits: { five_hour: info(40), seven_day: info(12) }, updatedAt: 9_000 }, profile)
    expect(merged.five_hour.info.utilization).toBe(70)
    expect(merged.seven_day).toEqual({ info: info(12), updatedAt: 9_000 })
  })

  it('carries the inferred-reset flag through untouched', () => {
    const profile: ProfileUsage = {
      five_hour: { info: info(0), updatedAt: 5_000, inferredReset: true },
    }
    const merged = mergeUsage({ rateLimits: { five_hour: info(93) }, updatedAt: 5_000 }, profile)
    expect(merged.five_hour.inferredReset).toBe(true)
    expect(merged.five_hour.updatedAt).toBe(5_000)
  })

  it('dates a session-only window with 0 when the transcript has no clock', () => {
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) } }, undefined)
    expect(merged.five_hour.updatedAt).toBe(0)
  })

  it('flattens back to the shape every existing meter reads', () => {
    const merged = mergeUsage({ rateLimits: { seven_day: info(12) }, updatedAt: 1 }, { five_hour: { info: info(70), updatedAt: 5_000 } })
    expect(usageInfos(merged)).toEqual({ five_hour: info(70), seven_day: info(12) })
  })
})
