import { describe, expect, it } from 'vitest'
import { USAGE_STALE_AFTER_MS, usageIsStale } from '@workerdeck/protocol'

const now = 1_800_000_000_000

describe('usageIsStale', () => {
  it('marks a reading older than the window, so a number from two days ago cannot pass for the truth', () => {
    expect(usageIsStale({ updatedAt: now - 2 * 24 * 60 * 60 * 1000 }, now)).toBe(true)
    expect(usageIsStale({ updatedAt: now - USAGE_STALE_AFTER_MS - 1 }, now)).toBe(true)
  })

  it('leaves a recent one alone', () => {
    expect(usageIsStale({ updatedAt: now }, now)).toBe(false)
    expect(usageIsStale({ updatedAt: now - USAGE_STALE_AFTER_MS + 1 }, now)).toBe(false)
  })

  it('never marks an inferred reset, which is derived from the wall clock and says so in its own words', () => {
    expect(usageIsStale({ updatedAt: now - 5 * 24 * 60 * 60 * 1000, inferredReset: true }, now)).toBe(false)
  })

  it('says nothing about a window that has never reported', () => {
    expect(usageIsStale({}, now)).toBe(false)
  })
})
