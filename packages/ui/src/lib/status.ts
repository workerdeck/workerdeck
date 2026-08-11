import type { ContextUsage, ModelOption, RateLimitInfo, SessionStatus } from '@workerdeck/protocol'

/**
 * How a session's live readings become a status line — the pure half, so every
 * host spells "Needs approval", "80% is a warning" and "which window is the
 * binding one" the same way.
 *
 * Structurally typed against `SessionVitals` rather than importing it: this file
 * ships from the React-free `@workerdeck/ui/format` entry, and a host drawing
 * the readings outside React (the VS Code extension host in the window status
 * bar) must not pull a component graph in to do it. A real `SessionVitals`
 * satisfies every shape here.
 */
export type StatusSeverity = 'none' | 'warning' | 'error'

/** What a status slot shows, before any host's icon vocabulary gets involved.
 * `icon` is a VS Code codicon name — the one host-shaped thing left, because the
 * alternative is a second mapping table in the only consumer. */
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
  if (!vitals) return { icon: 'hubot', label: 'Connecting…', severity: 'none' }
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
  if (pct === undefined) return 'none'
  if (pct >= 95) return 'error'
  if (pct >= 80) return 'warning'
  return 'none'
}

/** The rate-limit window that gets the one visible slot: whichever is fullest,
 * since the binding constraint is the one worth glancing at. */
export function tightestWindow(
  rateLimits: Record<string, RateLimitInfo> | undefined,
): { key: string; info: RateLimitInfo } | undefined {
  const entries = Object.entries(rateLimits ?? {})
  if (entries.length === 0) return undefined
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
    if (rank > bestRank) best = { key, info }
  }
  return best
}

/** A rate-limit window's key, named for a human. */
export function windowLabel(key: string): string {
  if (key === 'five_hour') return 'Session'
  if (key === 'seven_day') return 'Weekly'
  return key.replaceAll('_', ' ')
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
  if (!id) return undefined
  const bare = (value: string) => value.replace(/\[.*\]$/, '')
  const wanted = bare(id)
  return vitals.models.find(
    (m) => bare(m.value) === wanted || (m.resolvedModel && bare(m.resolvedModel) === wanted),
  )
}

/** A session's model, named the way the picker names it. Falls back to the raw
 * id, and to "Default" while the session is on the CLI's own pick. */
export function modelLabel(vitals: ModelReadings | undefined): string {
  if (!vitals?.model) return 'Default'
  return currentModel(vitals)?.displayName ?? vitals.model
}

/** Context percentage as its meter severity — the reading and the colour come
 * from one place so a panel and a status bar never disagree. */
export function contextSeverity(usage: ContextUsage | undefined): StatusSeverity {
  return meterSeverity(usage?.percentage)
}
