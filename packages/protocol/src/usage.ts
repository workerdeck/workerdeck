import type { ProfileUsage, RateLimitInfo } from './index.ts'

export type SessionUsage = {
  rateLimits?: Record<string, RateLimitInfo>
  updatedAt?: number
}

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

export type UsageWindowRow = {
  key: string
  info: RateLimitInfo
  updatedAt?: number
  inferredReset?: boolean
}

export const orderUsageWindows = (usage: ProfileUsage | undefined): UsageWindowRow[] => {
  const all = Object.entries(usage ?? {})
    .filter(([, w]) => w.info.utilization !== undefined)
    .map(([key, w]) => ({ key, info: w.info, updatedAt: w.updatedAt, inferredReset: w.inferredReset }))
  const named = ['five_hour', 'seven_day'].flatMap((key) => all.filter((w) => w.key === key))
  const perModel = all.filter((w) => w.key.startsWith('seven_day_')).sort((a, b) => a.key.localeCompare(b.key))
  return [...named, ...perModel]
}

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
