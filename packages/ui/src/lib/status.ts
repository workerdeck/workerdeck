import type { ModelOption, RateLimitInfo, SessionStatus } from '@workerdeck/protocol'

/**
 * How a session's live readings become a status line — the pure half, so every
 * host spells "Needs approval", "80% is a warning" and "which window is the
 * binding one" the same way.
 *
 * Structurally typed against `SessionVitals` rather than importing it: this
 * file ships from the React-free `@workerdeck/ui/format` entry, and a host
 * drawing the readings outside React must not pull a component graph in.
 */
export type StatusSeverity = 'none' | 'warning' | 'error'

/** What a status slot shows. `icon` is a VS Code codicon name — the one
 * host-shaped thing left, rather than a second mapping table in the only
 * consumer. */
export type StatusPresentation = {
  icon: string
  label: string
  severity: StatusSeverity
}

export type StatusReadings = {
  status: SessionStatus
  /** `@workerdeck/react`'s `ConnectionState`, structurally — the link state wins
   * the slot, so it has to be part of the reading. */
  connection?: 'live' | 'reconnecting' | 'offline'
}

const STATUS_META: Record<SessionStatus, StatusPresentation> = {
  starting: { icon: 'loading~spin', label: 'Starting', severity: 'none' },
  running: { icon: 'loading~spin', label: 'Running', severity: 'none' },
  awaiting_approval: { icon: 'warning', label: 'Needs approval', severity: 'warning' },
  idle: { icon: 'check', label: 'Idle', severity: 'none' },
  parked: { icon: 'debug-pause', label: 'Parked', severity: 'none' },
  failed: { icon: 'error', label: 'Failed', severity: 'error' },
  closed: { icon: 'circle-slash', label: 'Closed', severity: 'none' },
}

/**
 * The status slot, connection first. A session status held over a dead socket is
 * the last thing we heard, not the current state — so a lost link takes the slot
 * rather than letting "Running" imply a turn is still streaming.
 */
export function statusPresentation(vitals: StatusReadings | undefined): StatusPresentation {
  if (!vitals) {
    return { icon: 'hubot', label: 'Connecting…', severity: 'none' }
  }
  if (vitals.connection === 'offline') {
    return { icon: 'debug-disconnect', label: 'Offline', severity: 'error' }
  }
  if (vitals.connection === 'reconnecting') {
    return { icon: 'sync~spin', label: 'Reconnecting…', severity: 'warning' }
  }
  return STATUS_META[vitals.status] ?? { icon: 'hubot', label: vitals.status, severity: 'none' }
}

/** 0–100 → the colour a meter wears. One pair of thresholds for every surface. */
export function meterSeverity(pct: number | undefined): StatusSeverity {
  if (pct === undefined) {
    return 'none'
  }
  if (pct >= 95) {
    return 'error'
  }
  if (pct >= 80) {
    return 'warning'
  }
  return 'none'
}

/**
 * The three lanes a plan-usage reading can occupy, each independently
 * showable — `tightestWindow`'s single "fullest wins" slot would let a 71%
 * weekly window permanently hide the five-hour reading you watch while
 * working:
 *
 * - `'session'` — the five-hour window.
 * - `'weekly'` — the plain seven-day window, the account-wide ceiling.
 * - `'model'` — the fullest of the model-scoped weekly buckets. Deliberately
 *   not a named model: which models have their own bucket is the plan's
 *   business and changes without notice; the label comes from the key.
 */
export type UsageLane = 'session' | 'weekly' | 'model'

/** The window a lane points at, or `undefined` when this account has none. */
export function usageWindow(
  rateLimits: Record<string, RateLimitInfo> | undefined,
  lane: UsageLane,
): { key: string; info: RateLimitInfo } | undefined {
  if (!rateLimits) {
    return undefined
  }
  if (lane === 'session') {
    const info = rateLimits.five_hour
    return info ? { key: 'five_hour', info } : undefined
  }
  if (lane === 'weekly') {
    const info = rateLimits.seven_day
    return info ? { key: 'seven_day', info } : undefined
  }
  // Model-scoped: same "fullest wins" rule as the single slot, over the subset.
  const scoped = Object.fromEntries(
    Object.entries(rateLimits).filter(([key]) => key.startsWith('seven_day_') && key !== 'seven_day_oauth_apps'),
  )
  return tightestWindow(scoped)
}

/** The rate-limit window for a surface with exactly one slot: whichever is
 * fullest. {@link usageWindow} is for one with three. */
export function tightestWindow(rateLimits: Record<string, RateLimitInfo> | undefined): { key: string; info: RateLimitInfo } | undefined {
  const entries = Object.entries(rateLimits ?? {})
  if (entries.length === 0) {
    return undefined
  }
  let best: { key: string; info: RateLimitInfo } | undefined
  for (const [key, info] of entries) {
    // A rejected window outranks any utilization: it is the one actually blocking.
    const rank = info.status === 'rejected' ? Number.POSITIVE_INFINITY : (info.utilization ?? -1)
    const bestRank =
      best === undefined
        ? Number.NEGATIVE_INFINITY
        : best.info.status === 'rejected'
          ? Number.POSITIVE_INFINITY
          : (best.info.utilization ?? -1)
    if (rank > bestRank) {
      best = { key, info }
    }
  }
  return best
}

/** A rate-limit window's key, named for a human. A model-scoped bucket is
 * named for its model alone (`seven_day_fable` → "Fable"): its lane already
 * says weekly. */
export function windowLabel(key: string): string {
  if (key === 'five_hour') {
    return 'Session'
  }
  if (key === 'seven_day') {
    return 'Weekly'
  }
  const scoped = key.startsWith('seven_day_') ? key.slice('seven_day_'.length) : key
  const words = scoped.replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export type ModelReadings = { model?: string; models: readonly ModelOption[] }

/**
 * The catalog row a session is actually running, or `undefined` for a model the
 * list doesn't name. Matched leniently: a session reports the *resolved* id
 * (`claude-sonnet-5`) where the row may be keyed on the alias (`sonnet`), and
 * either can carry a `[1m]` context-window suffix.
 */
export function currentModel(vitals: ModelReadings | undefined): ModelOption | undefined {
  const id = vitals?.model
  if (!id) {
    return undefined
  }
  const bare = (value: string) => value.replace(/\[.*\]$/, '')
  const wanted = bare(id)
  return vitals.models.find((m) => bare(m.value) === wanted || (m.resolvedModel && bare(m.resolvedModel) === wanted))
}

/** A session's model, named the way the picker names it. Falls back to the raw
 * id, and to "Default" while the session is on the CLI's own pick. */
export function modelLabel(vitals: ModelReadings | undefined): string {
  if (!vitals?.model) {
    return 'Default'
  }
  return currentModel(vitals)?.displayName ?? vitals.model
}

/** Context percentage as its meter severity. Takes only the number it reads,
 * so the compact `ContextReading` and the full `ContextUsage` are coloured by
 * one rule. */
export function contextSeverity(usage: { percentage: number } | undefined): StatusSeverity {
  return meterSeverity(usage?.percentage)
}

/** {@link meterSeverity} as a text colour class — one copy of the thresholds
 * for every surface that paints the reading. */
export function meterColorClass(pct: number | undefined): string {
  const severity = meterSeverity(pct)
  return severity === 'error' ? 'text-danger' : severity === 'warning' ? 'text-warning' : 'text-fg-3'
}
