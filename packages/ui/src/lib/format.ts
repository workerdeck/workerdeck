export const formatCost = (usd: number | undefined): string => {
  if (usd === undefined || Number.isNaN(usd)) {
    return '—'
  }
  if (usd === 0) {
    return '$0.00'
  }
  if (usd < 0.01) {
    return '<$0.01'
  }
  return `$${usd.toFixed(2)}`
}

export const formatDuration = (ms: number): string => {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const s = ms / 1000
  if (s < 60) {
    return `${s.toFixed(1)}s`
  }
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export const formatTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return String(Math.round(tokens))
}

export const formatBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${bytes} B`
}

export const formatCountdown = (untilEpochMs: number, now = Date.now()): string => {
  const remaining = untilEpochMs - now
  if (remaining <= 0) {
    return 'now'
  }
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes < 1) {
    return '<1m'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const days = Math.floor(minutes / (60 * 24))
  if (days >= 1) {
    return `${days}d ${Math.floor((minutes % (60 * 24)) / 60)}h`
  }
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const formatRelativeTime = (epochMs: number | undefined, now = Date.now()): string => {
  if (!epochMs) {
    return '—'
  }
  const diff = Math.max(0, now - epochMs)
  const s = Math.floor(diff / 1000)
  if (s < 60) {
    return 'just now'
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ago`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return `${h}h ago`
  }
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export const formatRateLimitWindow = (key: string): string => {
  if (key === 'five_hour') {
    return '5h'
  }
  if (key === 'seven_day') {
    return '7d'
  }
  const spaced = key.replaceAll('_', ' ')
  return key.startsWith('seven_day_') ? `7d ${spaced.slice('seven day '.length)}` : spaced
}

export const formatRateLimitWindowLong = (key: string): string => {
  if (key === 'five_hour') {
    return '5-hour session'
  }
  if (key === 'seven_day') {
    return 'Weekly'
  }
  if (key === 'seven_day_oauth_apps') {
    return 'Weekly · apps'
  }
  const capitalize = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase())
  if (!key.startsWith('seven_day_')) {
    return capitalize(key.replaceAll('_', ' '))
  }
  return `Weekly · ${capitalize(key.slice('seven_day_'.length).replaceAll('_', ' '))}`
}

export const rateLimitWindowSeconds = (key: string): number | undefined => {
  if (key === 'five_hour') {
    return 5 * 3600
  }
  if (key.startsWith('seven_day')) {
    return 7 * 86_400
  }
  return undefined
}

export const formatAgoPrecise = (epochMs: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.floor((now - epochMs) / 1000))
  if (seconds < 60) {
    return `${seconds} sec${seconds === 1 ? '' : 's'} ago`
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes} min${minutes === 1 ? '' : 's'} ago`
  }
  const hours = Math.floor(seconds / 3600)
  return `${hours} hour${hours === 1 ? '' : 's'} ago`
}

export const toolInputPreview = (input: unknown, max = 80): string => {
  if (input === null || input === undefined) {
    return ''
  }
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const primary = o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern ?? o.query ?? o.description
    if (typeof primary === 'string') {
      return primary.length > max ? primary.slice(0, max - 1) + '…' : primary
    }
  }
  const text = JSON.stringify(input) ?? ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

const MODEL_FAMILIES: Record<string, { name: string; joiner?: string }> = {
  gpt: { name: 'GPT', joiner: '-' },
  deepseek: { name: 'DeepSeek' },
  glm: { name: 'GLM' },
  qwen: { name: 'Qwen' },
  kimi: { name: 'Kimi' },
  llama: { name: 'Llama' },
  mistral: { name: 'Mistral' },
  grok: { name: 'Grok' },
}

export const friendlyModel = (id: string | undefined): string | undefined => {
  if (!id) {
    return undefined
  }
  const withoutVariant = id.split('[')[0] ?? id
  const parts = withoutVariant.toLowerCase().split('-').filter(Boolean)
  if (parts[0] === 'claude') {
    parts.shift()
  }
  const familyToken = parts.shift()
  if (!familyToken) {
    return id
  }
  const family = MODEL_FAMILIES[familyToken]
  const name =
    family?.name ??
    // OpenAI's reasoning series is lower-case by its own convention ('o3-mini'); "O3" reads as a different product.
    (/^o\d+$/.test(familyToken) ? familyToken : `${familyToken.charAt(0).toUpperCase()}${familyToken.slice(1)}`)

  const version: string[] = []
  const words: string[] = []
  for (const part of parts) {
    if (/^\d{8}$/.test(part)) {
      continue
    }
    if (/^\d+(\.\d+)?$/.test(part)) {
      version.push(part)
    } else {
      words.push(`${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    }
  }
  const versioned = version.length > 0 ? `${name}${family?.joiner ?? ' '}${version.join('.')}` : name
  return [versioned, ...words].join(' ')
}
