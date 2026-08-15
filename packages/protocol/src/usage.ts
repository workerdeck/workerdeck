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
 * The usage a client should render: the gateway's per-profile state where it has
 * the window, this session's own reading where it does not.
 *
 * Why the profile wins outright rather than by comparing timestamps: the
 * gateway's `ProfileUsageTracker` is fed from **every** session on the profile —
 * including this one, from seq 0 — and keeps the newest reading per window by
 * the event's own `ts`. So for any window it holds, it holds a reading at least
 * as new as the one in this transcript, and a timestamp comparison could only
 * ever go wrong: the reducer keeps a *single* `updatedAt` for the whole map, so
 * a `five_hour` reading from this morning is dated with the afternoon's
 * `seven_day` event and would beat a genuinely fresher profile entry.
 *
 * The session half is not a fallback for correctness but for *coverage*: the
 * profile map is in-memory, so a restarted gateway serves nothing until a
 * session reports again, and a session with no profile has no account state at
 * all. In both cases the transcript's reading is the only one there is, and it
 * is dated honestly (see {@link SessionUsage.updatedAt}) rather than as now.
 *
 * Absent stays absent throughout: a window nobody has reported is **unknown,
 * never 0%**, and this returns an empty map rather than inventing entries.
 */
export function mergeUsage(session: SessionUsage, profile: ProfileUsage | undefined): ProfileUsage {
  const out: ProfileUsage = {}
  for (const [key, info] of Object.entries(session.rateLimits ?? {})) {
    out[key] = { info, updatedAt: session.updatedAt ?? 0 }
  }
  for (const [key, window] of Object.entries(profile ?? {})) out[key] = window
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
 * per-model weeklies alphabetically.
 *
 * Discovered rather than hardcoded — the engine's set of windows is an open
 * union and has grown before — but ordered, so the first two always mean the
 * same thing wherever they are drawn. A window with no `utilization` is
 * **unknown, not zero**, and is dropped entirely rather than rendered as an
 * empty bar that reads as "plenty left".
 *
 * Here rather than in a client because two surfaces now render the same windows
 * from different sources — the session panel from its merged state, the
 * dashboard's profile page straight off `ProfileInfo.usage` — and a list that
 * ordered or filtered differently would be the same account described two ways.
 */
export function orderUsageWindows(usage: ProfileUsage | undefined): UsageWindowRow[] {
  const all = Object.entries(usage ?? {})
    .filter(([, w]) => w.info.utilization !== undefined)
    .map(([key, w]) => ({ key, info: w.info, updatedAt: w.updatedAt, inferredReset: w.inferredReset }))
  const named = ['five_hour', 'seven_day'].flatMap((key) => all.filter((w) => w.key === key))
  const perModel = all
    .filter((w) => w.key.startsWith('seven_day_'))
    .sort((a, b) => a.key.localeCompare(b.key))
  return [...named, ...perModel]
}

/** The flat `rateLimitType → reading` map every existing renderer takes, out of
 * the dated form. Undefined in, undefined out — so a surface can keep telling
 * "no reading" apart from "an empty one". */
export function usageInfos(
  usage: ProfileUsage | undefined,
): Record<string, RateLimitInfo> | undefined {
  if (!usage) return undefined
  const out: Record<string, RateLimitInfo> = {}
  for (const [key, window] of Object.entries(usage)) out[key] = window.info
  return out
}
