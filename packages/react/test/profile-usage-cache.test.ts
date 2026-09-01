import { beforeEach, describe, expect, it } from 'vitest'
import { WorkerDeckClient } from '@workerdeck/client'
import type { ProfileUsage } from '@workerdeck/protocol'
import {
  clearProfileUsageCache,
  profileUsageCacheKey,
  readProfileUsageCache,
  writeProfileUsageCache,
} from '../src/lib/profile-usage-cache.ts'

function usage(utilization: number, updatedAt: number): ProfileUsage {
  return { five_hour: { info: { status: 'allowed', rateLimitType: 'five_hour', utilization }, updatedAt } }
}

describe('profile usage cache', () => {
  beforeEach(() => clearProfileUsageCache())

  it('keys by (gateway, principal, profile), not by client instance', () => {
    const a1 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'X-Key': 'k' } })
    const a2 = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'x-key': 'k' } })
    const b = new WorkerDeckClient({ baseUrl: 'http://two/v1', headers: { 'X-Key': 'k' } })
    const c = new WorkerDeckClient({ baseUrl: 'http://one/v1', headers: { 'X-Key': 'other' } })
    expect(profileUsageCacheKey(a1, 'work')).toBe(profileUsageCacheKey(a2, 'work'))
    expect(profileUsageCacheKey(a1, 'work')).not.toBe(profileUsageCacheKey(b, 'work'))
    expect(profileUsageCacheKey(a1, 'work')).not.toBe(profileUsageCacheKey(c, 'work'))
    expect(profileUsageCacheKey(a1, 'work')).not.toBe(profileUsageCacheKey(a1, 'personal'))
  })

  it('hands the last known reading back, so a session switch renders plan state instead of nothing', () => {
    writeProfileUsageCache('k', usage(86, 5_000))
    expect(readProfileUsageCache('k')?.five_hour.info.utilization).toBe(86)
  })

  // A gateway that answers without a usage block has not told us the plan is empty — it has told us nothing. Letting
  // that blank the cache would put the session's own (possibly days-old) replayed reading back on screen.
  it('never lets an absent reading erase what we already knew', () => {
    writeProfileUsageCache('k', usage(86, 5_000))
    writeProfileUsageCache('k', undefined)
    expect(readProfileUsageCache('k')?.five_hour.info.utilization).toBe(86)
  })

  it('replaces a stored reading with a fresher one', () => {
    writeProfileUsageCache('k', usage(86, 5_000))
    writeProfileUsageCache('k', usage(91, 9_000))
    expect(readProfileUsageCache('k')).toEqual(usage(91, 9_000))
  })

  it('clears', () => {
    writeProfileUsageCache('k', usage(86, 5_000))
    clearProfileUsageCache()
    expect(readProfileUsageCache('k')).toBeUndefined()
  })
})
