import type { ModelOption, RateLimitInfo, SessionStatus } from '@workerdeck/protocol'

export type StatusSeverity = 'none' | 'warning' | 'error'

export type StatusPresentation = {
  icon: string
  label: string
  severity: StatusSeverity
}

export type StatusReadings = {
  status: SessionStatus
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

export type UsageLane = 'session' | 'weekly' | 'model'

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
  const scoped = Object.fromEntries(
    Object.entries(rateLimits).filter(([key]) => key.startsWith('seven_day_') && key !== 'seven_day_oauth_apps'),
  )
  return tightestWindow(scoped)
}

export function tightestWindow(rateLimits: Record<string, RateLimitInfo> | undefined): { key: string; info: RateLimitInfo } | undefined {
  const entries = Object.entries(rateLimits ?? {})
  if (entries.length === 0) {
    return undefined
  }
  let best: { key: string; info: RateLimitInfo } | undefined
  for (const [key, info] of entries) {
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

export function currentModel(vitals: ModelReadings | undefined): ModelOption | undefined {
  const id = vitals?.model
  if (!id) {
    return undefined
  }
  const bare = (value: string) => value.replace(/\[.*\]$/, '')
  const wanted = bare(id)
  return vitals.models.find((m) => bare(m.value) === wanted || (m.resolvedModel && bare(m.resolvedModel) === wanted))
}

export function modelLabel(vitals: ModelReadings | undefined): string {
  if (!vitals?.model) {
    return 'Default'
  }
  return currentModel(vitals)?.displayName ?? vitals.model
}

export function contextSeverity(usage: { percentage: number } | undefined): StatusSeverity {
  return meterSeverity(usage?.percentage)
}

export function meterColorClass(pct: number | undefined): string {
  const severity = meterSeverity(pct)
  return severity === 'error' ? 'text-danger' : severity === 'warning' ? 'text-warning' : 'text-fg-3'
}

/**
 * The fill colour for a meter bar. Deliberately a different ramp from
 * {@link meterColorClass}: a bar reads as alarming later than a number does, so the tint
 * turns at 70/90 where the text severity turns at 80/95.
 */
export function meterTintClass(pct: number): string {
  return pct >= 90 ? 'bg-danger' : pct >= 70 ? 'bg-warning' : 'bg-accent'
}
