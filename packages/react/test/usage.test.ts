import { describe, expect, it } from 'vitest'
import { mergeUsage, usageInfos } from '@workerdeck/protocol'
import type { ProfileUsage, RateLimitInfo } from '@workerdeck/protocol'

const info = (utilization: number, extra: Partial<RateLimitInfo> = {}): RateLimitInfo => ({
  status: 'allowed',
  rateLimitType: 'five_hour',
  utilization,
  ...extra,
})

describe('mergeUsage', () => {
  it('is empty when neither side has reported', () => {
    expect(mergeUsage({}, undefined)).toEqual({})
    // Absent must stay distinguishable from 0% — no window is invented here.
    expect(usageInfos(undefined)).toBeUndefined()
  })

  it("stands the session's own reading up when the gateway holds nothing", () => {
    // The restart case: the profile map is in-memory, so it serves nothing until
    // a session reports again. The transcript's reading is then all there is.
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) }, updatedAt: 1_000 }, undefined)
    expect(merged).toEqual({ five_hour: { info: info(40), updatedAt: 1_000 } })
  })

  it('prefers the profile reading over the session it came from', () => {
    const profile: ProfileUsage = { five_hour: { info: info(70), updatedAt: 5_000 } }
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) }, updatedAt: 1_000 }, profile)
    expect(merged.five_hour).toEqual({ info: info(70), updatedAt: 5_000 })
  })

  it('prefers the profile reading even when the session state looks newer', () => {
    // The reason a timestamp comparison would be wrong: the reducer keeps ONE
    // clock for the whole map, so this session's morning `five_hour` is dated
    // with the afternoon `seven_day` event that followed it. The gateway's
    // per-window reading is fed from every session, including this one, so it is
    // never older than what this transcript holds.
    const profile: ProfileUsage = { five_hour: { info: info(70), updatedAt: 5_000 } }
    const merged = mergeUsage({ rateLimits: { five_hour: info(40), seven_day: info(12) }, updatedAt: 9_000 }, profile)
    expect(merged.five_hour.info.utilization).toBe(70)
    // ...and a window the gateway does not hold is still the session's.
    expect(merged.seven_day).toEqual({ info: info(12), updatedAt: 9_000 })
  })

  it('carries the inferred-reset flag through untouched', () => {
    const profile: ProfileUsage = {
      five_hour: { info: info(0), updatedAt: 5_000, inferredReset: true },
    }
    const merged = mergeUsage({ rateLimits: { five_hour: info(93) }, updatedAt: 5_000 }, profile)
    expect(merged.five_hour.inferredReset).toBe(true)
    // The date stays the *reading's*, not the moment it was zeroed: "updated"
    // must not claim freshness the server's clock arithmetic did not give it.
    expect(merged.five_hour.updatedAt).toBe(5_000)
  })

  it('dates a session-only window with 0 when the transcript has no clock', () => {
    // Only reachable from a hand-built state; a surface then shows no "updated"
    // line rather than dating the reading as now.
    const merged = mergeUsage({ rateLimits: { five_hour: info(40) } }, undefined)
    expect(merged.five_hour.updatedAt).toBe(0)
  })

  it('flattens back to the shape every existing meter reads', () => {
    const merged = mergeUsage({ rateLimits: { seven_day: info(12) }, updatedAt: 1 }, { five_hour: { info: info(70), updatedAt: 5_000 } })
    expect(usageInfos(merged)).toEqual({ five_hour: info(70), seven_day: info(12) })
  })
})
