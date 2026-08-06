export function formatCost(usd: number | undefined): string {
  if (usd === undefined || Number.isNaN(usd)) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

/** Compact token count, Claude Code-style: 850 → "850", 359_000 → "359.0k", 1_200_000 → "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(Math.round(tokens))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** Countdown to an epoch-ms deadline: "2h 18m", "12m", "<1m"; "now" once passed. */
export function formatCountdown(untilEpochMs: number, now = Date.now()): string {
  const remaining = untilEpochMs - now
  if (remaining <= 0) return 'now'
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const days = Math.floor(minutes / (60 * 24))
  if (days >= 1) return `${days}d ${Math.floor((minutes % (60 * 24)) / 60)}h`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatRelativeTime(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs) return '—'
  const diff = Math.max(0, now - epochMs)
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/**
 * Human label for a rate-limit window key, compact: 'five_hour' → "5h",
 * 'seven_day_opus' → "7d opus". The per-model suffix is an open set — the CLI
 * adds buckets as plans gain them — so it is rewritten rather than enumerated.
 */
export function formatRateLimitWindow(key: string): string {
  if (key === 'five_hour') return '5h'
  if (key === 'seven_day') return '7d'
  const spaced = key.replaceAll('_', ' ')
  return key.startsWith('seven_day_') ? `7d ${spaced.slice('seven day '.length)}` : spaced
}

/** The same key spelled out, where there is room: 'five_hour' → "5-hour
 * session", 'seven_day_fable' → "Weekly · Fable". */
export function formatRateLimitWindowLong(key: string): string {
  if (key === 'five_hour') return '5-hour session'
  if (key === 'seven_day') return 'Weekly'
  if (key === 'seven_day_oauth_apps') return 'Weekly · apps'
  const capitalize = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
  if (!key.startsWith('seven_day_')) return capitalize(key.replaceAll('_', ' '))
  return `Weekly · ${capitalize(key.slice('seven_day_'.length).replaceAll('_', ' '))}`
}

/**
 * How long a rate-limit window is, in seconds — the denominator behind the pace
 * marker. Derived from the key rather than reported: the CLI sends a reset time
 * and a percentage, never a duration. `undefined` for a window whose key doesn't
 * say, and the marker is then simply not drawn rather than guessed.
 */
export function rateLimitWindowSeconds(key: string): number | undefined {
  if (key === 'five_hour') return 5 * 3600
  if (key.startsWith('seven_day')) return 7 * 86_400
  return undefined
}

/** "8 secs ago" / "3 mins ago" — a freshness line finer-grained than
 * {@link formatRelativeTime}, because a poll that just landed should say so. */
export function formatAgoPrecise(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000))
  if (seconds < 60) return `${seconds} sec${seconds === 1 ? '' : 's'} ago`
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`
  }
  const hours = Math.floor(seconds / 3600)
  return `${hours} hour${hours === 1 ? '' : 's'} ago`
}

/** Compact one-line preview of a tool input for card headers. */
export function toolInputPreview(input: unknown, max = 80): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const primary =
      o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern ?? o.query ?? o.description
    if (typeof primary === 'string') {
      return primary.length > max ? primary.slice(0, max - 1) + '…' : primary
    }
  }
  const text = JSON.stringify(input) ?? ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
