import type { ProfileUsage, RateLimitInfo } from './index.ts'

/**
 * What one session was last told about the plan's windows: the transcript's own
 * rate-limit state, and the event clock of the newest reading in it.
 *
 * Deliberately structural rather than `TranscriptState` — protocol may not
 * import a client — and it is exactly the two fields the reducer keeps.
 */
export type SessionUsage = {
  /** Keyed by `rateLimitType`, as the reducer stores it. */
  rateLimits?: Record<string, RateLimitInfo>
  /** Epoch ms of the newest `rate_limit` event this session saw — one clock for
   * the whole map, which is all the reducer records. */
  updatedAt?: number
}

/**
 * The usage a client should render: the gateway's per-profile state wins every
 * window it holds, this session's own reading fills the rest.
 *
 * The profile wins **outright, never by comparing timestamps** — the reducer
 * keeps a single `updatedAt` for the whole map, so this session's morning
 * `five_hour` is dated with its afternoon `seven_day` event and would beat a
 * genuinely fresher profile entry. The session half is coverage, not
 * correctness. Absent stays absent: a window nobody reported is **unknown,
 * never 0%**. (docs/GOTCHAS.md §Claude engine.)
 */
export const mergeUsage = (session: SessionUsage, profile: ProfileUsage | undefined): ProfileUsage => {
  const out: ProfileUsage = {}
  for (const [key, info] of Object.entries(session.rateLimits ?? {})) {
    out[key] = { info, updatedAt: session.updatedAt ?? 0 }
  }
  for (const [key, window] of Object.entries(profile ?? {})) {
    out[key] = window
  }
  return out
}

/** One window as a surface draws it: the reading, its own date, and whether the
 * gateway is the one that zeroed it. */
export type UsageWindowRow = {
  key: string
  info: RateLimitInfo
  /** Epoch ms of the reading. Absent only for a hand-built state with no clock. */
  updatedAt?: number
  inferredReset?: boolean
}

/**
 * The windows in reading order: the session window, the weekly one, then the
 * per-model weeklies alphabetically. Discovered rather than hardcoded (the
 * engine's set is an open union) but ordered, so the first two always mean the
 * same thing wherever they are drawn.
 *
 * A window with no `utilization` is **unknown, not zero**, and is dropped rather
 * than drawn as an empty bar reading "plenty left". Here rather than in a client
 * because the panel and the dashboard's profile page render the same windows
 * from different sources.
 */
export const orderUsageWindows = (usage: ProfileUsage | undefined): UsageWindowRow[] => {
  const all = Object.entries(usage ?? {})
    .filter(([, w]) => w.info.utilization !== undefined)
    .map(([key, w]) => ({ key, info: w.info, updatedAt: w.updatedAt, inferredReset: w.inferredReset }))
  const named = ['five_hour', 'seven_day'].flatMap((key) => all.filter((w) => w.key === key))
  const perModel = all.filter((w) => w.key.startsWith('seven_day_')).sort((a, b) => a.key.localeCompare(b.key))
  return [...named, ...perModel]
}

/** The flat `rateLimitType → reading` map every existing renderer takes, out of
 * the dated form. Undefined in, undefined out — so a surface can keep telling
 * "no reading" apart from "an empty one". */
export const usageInfos = (usage: ProfileUsage | undefined): Record<string, RateLimitInfo> | undefined => {
  if (!usage) {
    return undefined
  }
  const out: Record<string, RateLimitInfo> = {}
  for (const [key, window] of Object.entries(usage)) {
    out[key] = window.info
  }
  return out
}
