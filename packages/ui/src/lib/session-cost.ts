import {
  type ByModel,
  type CostBasis,
  type CostBreakdown,
  type PricingTable,
  type TokenUsage,
  UNPRICED_WARN_SHARE,
  canonicalModel,
  costOf,
  costOfByModel,
  rateFor,
  totalTokens,
  unknownBasisModels,
} from '@workerdeck/protocol'

export type SessionCostRow = {
  model: string
  usage: TokenUsage
  tokens: number
  costUsd: number | undefined
  costBasis: CostBasis | undefined
}

export type SessionCost = {
  displayUsd: number | undefined
  computedUsd: number | undefined
  reportedUsd: number | undefined
  breakdown: CostBreakdown
  rows: SessionCostRow[]
  unpricedShare: number
  showUnpricedWarning: boolean
  // Models the engine itself could not match to a rate table, so the figure *it* reports for them is a guess.
  unknownBasisModels: string[]
  // Both figures price the same tokens, one by the engine and one by us, so a gap is the thing worth reading.
  gapUsd: number | undefined
}

export type SessionCostInput = {
  costUsd?: number
  totalCostUsd?: number
  usageByModel?: ByModel
  pricing?: PricingTable
}

const GAP_SHARE = 0.02

export function sessionCost(input: SessionCostInput): SessionCost {
  const byModel = input.usageByModel ?? {}
  const pricing = input.pricing
  const breakdown = costOfByModel(byModel, pricing)
  const computedUsd = input.costUsd ?? (breakdown.unpriced || Object.keys(byModel).length === 0 ? undefined : breakdown.total)
  const reportedUsd = input.totalCostUsd
  const rows = Object.entries(byModel)
    .map(([model, usage]) => ({
      model: canonicalModel(model),
      usage,
      tokens: totalTokens(usage),
      costUsd: rateFor(model, pricing) ? costOf(usage, model, pricing).total : undefined,
      costBasis: usage.costBasis,
    }))
    .sort((a, b) => b.tokens - a.tokens)
  const gap = computedUsd !== undefined && reportedUsd !== undefined ? reportedUsd - computedUsd : undefined
  const worthShowing = gap !== undefined && Math.abs(gap) > Math.max(0.01, GAP_SHARE * Math.max(computedUsd ?? 0, reportedUsd ?? 0))
  return {
    displayUsd: computedUsd ?? reportedUsd,
    computedUsd,
    reportedUsd,
    breakdown,
    rows,
    unpricedShare: breakdown.unpricedShare,
    showUnpricedWarning: breakdown.unpricedShare > UNPRICED_WARN_SHARE,
    unknownBasisModels: unknownBasisModels(byModel),
    gapUsd: worthShowing ? gap : undefined,
  }
}
