import {
  usageIsStale,
  type ContextUsageCategory,
  type ContextReading,
  type ProfileEngine,
  type SessionEvent,
  type SessionInfo,
} from '@workerdeck/protocol'
import { defineToolFamily, type GatewayToolOutput } from './gateway-tools.ts'

export type SessionReportSource = () => Promise<SessionReport>

export type ContextMeasurement = 'live' | 'last_turn'

export type SessionContextReport = {
  usedTokens: number
  maxTokens: number | null
  percent: number | null
  remainingTokens: number | null
  measured: ContextMeasurement
  categories?: Array<{ name: string; tokens: number }>
  note?: string
}

export type SessionRateLimitReport = {
  window: string
  status: string
  usedPercent: number | null
  resetsAt: string | null
  usingOverage?: boolean
  observedAt: string
  stale: boolean
}

export type SessionReport = {
  session: { id: string; title?: string; profile?: string; cwd?: string; status: string; createdAt: string }
  engine: ProfileEngine
  vendor: string | null
  model: string | null
  permissionMode?: string
  context: SessionContextReport | null
  turns: number
  cost: { usd: number | null; basis: 'list_price_estimate' | 'engine_reported' | 'unpriced' }
  rateLimits: SessionRateLimitReport[] | null
  notes?: string[]
}

export type LiveContext = {
  totalTokens: number
  maxTokens?: number
  categories?: readonly ContextUsageCategory[]
  measured: ContextMeasurement
}

export type SessionReportInput = {
  info: SessionInfo
  vendor: string | undefined
  context: LiveContext | undefined
  events: readonly SessionEvent[]
  rateLimitsSupported: boolean
  contextNote?: string
  now?: number
}

export const SESSION_INFO_TOOL = 'session_info'

const SESSION_INFO_TOOL_SHAPES = {
  [SESSION_INFO_TOOL]: {
    description:
      'Report facts about your own session: engine, vendor and model, context window usage (tokens used, window size, percent, ' +
      'remaining), turn count, cost so far and the account-level rate-limit windows. Use it to pace your work: when the context ' +
      'is filling up, finish the current step, summarise, or suggest compaction or a fresh session before quality degrades; when a ' +
      'rate-limit window is close to its limit, prefer cheaper approaches.',
    shape: {},
  },
} as const

const SESSION_INFO_TOOLS = defineToolFamily<typeof SESSION_INFO_TOOL_SHAPES, SessionReportSource>(SESSION_INFO_TOOL_SHAPES, {
  [SESSION_INFO_TOOL]: async (report) => ({ text: JSON.stringify(await report(), null, 2), isError: false }),
})

export const SESSION_INFO_TOOL_SHAPE = SESSION_INFO_TOOL_SHAPES[SESSION_INFO_TOOL]

export function isSessionInfoToolName(name: string): name is typeof SESSION_INFO_TOOL {
  return SESSION_INFO_TOOLS.is(name)
}

export function runSessionInfoTool(report: SessionReportSource, from: string): Promise<GatewayToolOutput> {
  return SESSION_INFO_TOOLS.run(report, from, SESSION_INFO_TOOL, {})
}

export function buildSessionReport(input: SessionReportInput): SessionReport {
  const { info } = input
  const now = input.now ?? Date.now()
  const rateLimits = input.rateLimitsSupported ? rateLimitReports(input.events, now) : null
  const notes: string[] = []
  if (!input.rateLimitsSupported) {
    notes.push('This engine does not report account rate limits.')
  } else if (rateLimits?.length === 0) {
    notes.push('No rate-limit reading yet; one arrives after the first turn.')
  }
  return {
    session: {
      id: info.id,
      ...(info.title ? { title: info.title } : {}),
      ...(info.profile ? { profile: info.profile } : {}),
      ...(info.cwd ? { cwd: info.cwd } : {}),
      status: info.status,
      createdAt: new Date(info.createdAt).toISOString(),
    },
    engine: info.engine ?? 'claude',
    vendor: input.vendor ?? null,
    model: info.model ?? null,
    ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
    context: contextReport(input.context, input.contextNote),
    turns: info.numTurns ?? 0,
    cost: costReport(info),
    rateLimits,
    ...(notes.length ? { notes } : {}),
  }
}

export function liveContextFromReading(reading: ContextReading | undefined): LiveContext | undefined {
  return reading ? { totalTokens: reading.totalTokens, maxTokens: reading.maxTokens, measured: 'last_turn' } : undefined
}

export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export function providerVendor(provider: string | undefined): string | undefined {
  const head = provider?.split('.')[0]?.trim()
  return head || undefined
}

function contextReport(context: LiveContext | undefined, note: string | undefined): SessionContextReport | null {
  if (!context) {
    return null
  }
  const max = context.maxTokens && context.maxTokens > 0 ? context.maxTokens : undefined
  const report: SessionContextReport = {
    usedTokens: context.totalTokens,
    maxTokens: max ?? null,
    percent: max === undefined ? null : Math.round(Math.min(100, (context.totalTokens / max) * 100) * 10) / 10,
    remainingTokens: max === undefined ? null : Math.max(0, max - context.totalTokens),
    measured: context.measured,
  }
  if (context.categories?.length) {
    report.categories = context.categories.map((category) => ({ name: category.name, tokens: category.tokens }))
  }
  if (note) {
    report.note = note
  }
  return report
}

function rateLimitReports(events: readonly SessionEvent[], now: number): SessionRateLimitReport[] {
  const latest = new Map<string, Extract<SessionEvent, { type: 'rate_limit' }>>()
  for (const event of events) {
    if (event.type === 'rate_limit' && event.info.rateLimitType) {
      latest.set(event.info.rateLimitType, event)
    }
  }
  return [...latest.values()].map((event) => {
    const { info } = event
    const reset = info.resetsAt === undefined ? undefined : info.resetsAt * 1000
    return {
      window: info.rateLimitType!,
      status: info.status,
      usedPercent: reset !== undefined && reset <= now ? 0 : (info.utilization ?? null),
      resetsAt: reset === undefined ? null : new Date(reset).toISOString(),
      ...(info.isUsingOverage ? { usingOverage: true } : {}),
      observedAt: new Date(event.ts).toISOString(),
      stale: usageIsStale({ updatedAt: event.ts }, now),
    }
  })
}

function costReport(info: SessionInfo): SessionReport['cost'] {
  if (info.costUsd !== undefined) {
    return { usd: roundUsd(info.costUsd), basis: 'list_price_estimate' }
  }
  if (info.totalCostUsd !== undefined) {
    return { usd: roundUsd(info.totalCostUsd), basis: 'engine_reported' }
  }
  return { usd: null, basis: 'unpriced' }
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
