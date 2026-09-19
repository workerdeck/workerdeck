import type { ProfileUsage, RateLimitInfo } from './index.ts'

export type SessionUsage = {
  rateLimits?: Record<string, RateLimitInfo>
  updatedAt?: number
}

export function mergeUsage(session: SessionUsage, profile: ProfileUsage | undefined): ProfileUsage {
  const out: ProfileUsage = {}
  for (const [key, info] of Object.entries(session.rateLimits ?? {})) {
    out[key] = { info, updatedAt: session.updatedAt ?? 0 }
  }
  for (const [key, window] of Object.entries(profile ?? {})) {
    out[key] = window
  }
  return out
}

// A rate-limit reading is a poll, not a stream: the engine reports one at a turn boundary, on an attach and on a
// profiles read, and nothing in between. A window older than this is still the best answer anyone has, and it is
// no longer a claim about right now, so every surface marks it rather than drawing it as current. Minutes, not
// hours: the windows move over hours, so a reading from this morning can be wrong by a lot.
export const USAGE_STALE_AFTER_MS = 15 * 60_000

export function usageIsStale(row: Pick<UsageWindowRow, 'updatedAt' | 'inferredReset'>, now: number): boolean {
  // An inferred reset is not stale, it is derived at serve time from the wall clock, and it says so in its own words.
  if (row.inferredReset || row.updatedAt === undefined) {
    return false
  }
  return now - row.updatedAt > USAGE_STALE_AFTER_MS
}

export type UsageWindowRow = {
  key: string
  info: RateLimitInfo
  updatedAt?: number
  inferredReset?: boolean
}

export function orderUsageWindows(usage: ProfileUsage | undefined): UsageWindowRow[] {
  const all = Object.entries(usage ?? {})
    .filter(([, w]) => w.info.utilization !== undefined)
    .map(([key, w]) => ({ key, info: w.info, updatedAt: w.updatedAt, inferredReset: w.inferredReset }))
  const named = ['five_hour', 'seven_day'].flatMap((key) => all.filter((w) => w.key === key))
  const perModel = all.filter((w) => w.key.startsWith('seven_day_')).sort((a, b) => a.key.localeCompare(b.key))
  return [...named, ...perModel]
}

export function usageInfos(usage: ProfileUsage | undefined): Record<string, RateLimitInfo> | undefined {
  if (!usage) {
    return undefined
  }
  const out: Record<string, RateLimitInfo> = {}
  for (const [key, window] of Object.entries(usage)) {
    out[key] = window.info
  }
  return out
}
