export type CostBasis = 'list' | 'managed' | 'unknown'

export type TokenUsage = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  costBasis?: CostBasis
}

export type ByModel = Record<string, TokenUsage>

export type ModelRate = {
  input: number
  output: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export type CostBreakdown = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
  unpriced: boolean
  unpricedTokens: number
  unpricedShare: number
}

export const PRICING_AS_OF = '2026-09-19'

export const PRICING_SOURCES = 'platform.claude.com and developers.openai.com list prices, bundled'

export const PRICING_NOTE = `List rates as of ${PRICING_AS_OF}. A subscription is a flat fee, so this is what the same tokens would have cost on the pay-as-you-go API, not a bill.`

export const UNPRICED_WARN_SHARE = 0.005

export const PRICING_STALE_DAYS = 90

const MTOK = 1_000_000

const DAY_MS = 86_400_000

const BASIS_ORDER: Record<CostBasis, number> = { list: 0, managed: 1, unknown: 2 }

const RATE_FIELDS = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'] as const

const WEEKS_PER_MONTH = 52 / 12

function anthropicRate(input: number, output: number, cacheRead?: number): ModelRate {
  return { input, output, cacheWrite5m: input * 1.25, cacheWrite1h: input * 2, cacheRead: cacheRead ?? input * 0.1 }
}

function openaiRate(input: number, output: number, cacheRead: number): ModelRate {
  return { input, output, cacheWrite5m: input, cacheWrite1h: input, cacheRead }
}

export const DEFAULT_PRICING: Record<string, ModelRate> = {
  'claude-fable-5-1': anthropicRate(10, 50, 0.25),
  'claude-fable-5': anthropicRate(10, 50),
  'claude-mythos-5-1': anthropicRate(10, 50, 0.25),
  'claude-mythos-5': anthropicRate(10, 50),
  'claude-opus-5': anthropicRate(5, 25),
  'claude-opus-4-8': anthropicRate(5, 25),
  'claude-opus-4-7': anthropicRate(5, 25),
  'claude-opus-4-6': anthropicRate(5, 25),
  'claude-opus-4-5': anthropicRate(5, 25),
  'claude-sonnet-5': anthropicRate(2, 10),
  'claude-sonnet-4-6': anthropicRate(3, 15),
  'claude-sonnet-4-5': anthropicRate(3, 15),
  'claude-haiku-4-5': anthropicRate(1, 5),
  'gpt-6-astra': openaiRate(10, 50, 1),
  'gpt-5.6-sol': openaiRate(4, 20, 0.4),
  'gpt-5.6-terra': openaiRate(2, 12, 0.2),
  'gpt-5.6-luna': openaiRate(0.2, 1.2, 0.02),
  'gpt-5.5': openaiRate(5, 30, 0.5),
  'gpt-5.4': openaiRate(2.5, 15, 0.25),
  'gpt-5.2': openaiRate(1.75, 14, 0.175),
  'gpt-5.1': openaiRate(1.25, 10, 0.125),
  'gpt-5': openaiRate(1.25, 10, 0.125),
}

export type PricingTable = Record<string, ModelRate>

export type PricingOverrides = Record<string, ModelRate>

export type PricingMerge = {
  pricing: PricingTable
  overrides: PricingOverrides
  dropped: string[]
}

let activeTable: PricingTable = DEFAULT_PRICING

function rateFromInput(value: unknown): ModelRate | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const rate: ModelRate = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }
  for (const field of RATE_FIELDS) {
    const rest = raw[field]
    if (typeof rest !== 'number' || !Number.isFinite(rest) || rest < 0) {
      return undefined
    }
    rate[field] = rest
  }
  return rate
}

export function mergePricing(overrides: unknown, base: PricingTable = DEFAULT_PRICING): PricingMerge {
  const accepted: PricingOverrides = {}
  const dropped: string[] = []
  if (overrides !== null && typeof overrides === 'object') {
    for (const [model, value] of Object.entries(overrides as Record<string, unknown>)) {
      const rate = rateFromInput(value)
      const key = canonicalModel(model)
      if (!rate || key === '') {
        dropped.push(model)
        continue
      }
      accepted[key] = rate
    }
  }
  return { pricing: { ...base, ...accepted }, overrides: accepted, dropped }
}

export function activePricing(): PricingTable {
  return activeTable
}

// The table is process-wide configuration, like the bundled rates it replaces entries in, so the gateway sets it
// once at start and every pricing call that names no table of its own reads it.
export function setPricingOverrides(overrides: unknown): PricingMerge {
  const merged = mergePricing(overrides)
  activeTable = merged.pricing
  return merged
}

export function pricingAgeDays(now: number, asOf: string = PRICING_AS_OF): number {
  const dated = Date.parse(asOf)
  return Number.isFinite(dated) ? Math.floor((now - dated) / DAY_MS) : 0
}

export function pricingAgeNote(now: number, asOf: string = PRICING_AS_OF): string | undefined {
  const days = pricingAgeDays(now, asOf)
  if (days <= PRICING_STALE_DAYS) {
    return undefined
  }
  return `This rate table is ${days} days old, so check the vendor's current list prices before you trust the total.`
}

export function canonicalModel(model: string): string {
  const slash = model.lastIndexOf('/')
  const withoutProvider = slash === -1 ? model : model.slice(slash + 1)
  return withoutProvider
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z]+\.)*anthropic\./, '')
    .replace(/[@-]\d{8}$/, '')
    .replace(/-v\d+:\d+$/, '')
}

export function rateFor(model: string | undefined, pricing: PricingTable = activePricing()): ModelRate | undefined {
  return model ? pricing[canonicalModel(model)] : undefined
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead
}

export function addTokenUsage(into: TokenUsage, add: TokenUsage): TokenUsage {
  return {
    input: into.input + add.input,
    output: into.output + add.output,
    cacheWrite5m: into.cacheWrite5m + add.cacheWrite5m,
    cacheWrite1h: into.cacheWrite1h + add.cacheWrite1h,
    cacheRead: into.cacheRead + add.cacheRead,
    costBasis: worseBasis(into.costBasis, add.costBasis),
  }
}

// A total priced on a basis the engine could not identify stays suspect however little of it there was,
// so the worse basis wins rather than the newer one.
export function worseBasis(a: CostBasis | undefined, b: CostBasis | undefined): CostBasis | undefined {
  if (a === undefined) {
    return b
  }
  if (b === undefined) {
    return a
  }
  return BASIS_ORDER[a] >= BASIS_ORDER[b] ? a : b
}

export function unknownBasisModels(byModel: ByModel): string[] {
  return Object.entries(byModel)
    .filter(([, usage]) => usage.costBasis === 'unknown')
    .map(([model]) => canonicalModel(model))
}

export function mergeByModel(into: ByModel, add: ByModel): ByModel {
  const out: ByModel = { ...into }
  for (const [model, usage] of Object.entries(add)) {
    out[model] = addTokenUsage(out[model] ?? emptyTokenUsage(), usage)
  }
  return out
}

export function byModelTotalTokens(byModel: ByModel): number {
  let total = 0
  for (const usage of Object.values(byModel)) {
    total += totalTokens(usage)
  }
  return total
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function tokenUsageFromWire(usage: unknown): TokenUsage {
  if (usage === null || typeof usage !== 'object') {
    return emptyTokenUsage()
  }
  const wire = usage as {
    input_tokens?: unknown
    output_tokens?: unknown
    cache_creation_input_tokens?: unknown
    cache_read_input_tokens?: unknown
    cache_creation?: { ephemeral_5m_input_tokens?: unknown; ephemeral_1h_input_tokens?: unknown } | null
  }
  const split = wire.cache_creation
  const write1h = num(split?.ephemeral_1h_input_tokens)
  const write5m = split ? num(split.ephemeral_5m_input_tokens) : num(wire.cache_creation_input_tokens)
  return {
    input: num(wire.input_tokens),
    output: num(wire.output_tokens),
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: num(wire.cache_read_input_tokens),
  }
}

function unpricedBreakdown(tokens: number): CostBreakdown {
  return {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    total: 0,
    unpriced: true,
    unpricedTokens: tokens,
    unpricedShare: tokens > 0 ? 1 : 0,
  }
}

export function costOf(usage: TokenUsage, model: string | undefined, pricing: PricingTable = activePricing()): CostBreakdown {
  const rate = rateFor(model, pricing)
  if (!rate) {
    return unpricedBreakdown(totalTokens(usage))
  }
  const input = (usage.input / MTOK) * rate.input
  const output = (usage.output / MTOK) * rate.output
  const cacheWrite = (usage.cacheWrite5m / MTOK) * rate.cacheWrite5m + (usage.cacheWrite1h / MTOK) * rate.cacheWrite1h
  const cacheRead = (usage.cacheRead / MTOK) * rate.cacheRead
  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    total: input + output + cacheWrite + cacheRead,
    unpriced: false,
    unpricedTokens: 0,
    unpricedShare: 0,
  }
}

export function costOfByModel(byModel: ByModel, pricing: PricingTable = activePricing()): CostBreakdown {
  const acc: CostBreakdown = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    total: 0,
    unpriced: false,
    unpricedTokens: 0,
    unpricedShare: 0,
  }
  const models = Object.entries(byModel)
  let anyPriced = false
  let tokens = 0
  for (const [model, usage] of models) {
    tokens += totalTokens(usage)
    const cost = costOf(usage, model, pricing)
    if (cost.unpriced) {
      acc.unpricedTokens += cost.unpricedTokens
      continue
    }
    anyPriced = true
    acc.input += cost.input
    acc.output += cost.output
    acc.cacheWrite += cost.cacheWrite
    acc.cacheRead += cost.cacheRead
    acc.total += cost.total
  }
  acc.unpriced = !anyPriced && models.length > 0
  acc.unpricedShare = tokens > 0 ? acc.unpricedTokens / tokens : 0
  return acc
}

export function unpricedModels(byModel: ByModel, pricing: PricingTable = activePricing()): string[] {
  return Object.keys(byModel).filter((model) => rateFor(model, pricing) === undefined)
}

// Rate limits meter fresh input, output and cache writes; a cache read is nearly free to serve and does not
// count against a plan window, which is why quota burn and API-equivalent cost diverge on an agentic workload.
export function meteredCost(cost: CostBreakdown): number {
  return cost.input + cost.output + cost.cacheWrite
}

export type SubscriptionComparison = {
  weeklyUsd: number
  monthlyUsd: number
  weeklyShareUsd: number
  ratio: number
}

export function subscriptionComparison(weeklyUsd: number, monthlyUsd: number): SubscriptionComparison | undefined {
  if (!(monthlyUsd > 0) || !Number.isFinite(weeklyUsd) || weeklyUsd < 0) {
    return undefined
  }
  const weeklyShareUsd = monthlyUsd / WEEKS_PER_MONTH
  return { weeklyUsd, monthlyUsd, weeklyShareUsd, ratio: weeklyUsd / weeklyShareUsd }
}

export type ProfileSpend = {
  weekUsd: number
  monthUsd: number
  weekByModel: ByModel
  unpricedShare: number
  monthlySubscriptionUsd?: number
  subscription?: SubscriptionComparison
}
