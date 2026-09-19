import {
  type ByModel,
  type CostBreakdown,
  type TokenUsage,
  addTokenUsage,
  byModelTotalTokens,
  canonicalModel,
  costOfByModel,
  emptyTokenUsage,
  mergeByModel,
  totalTokens,
} from '@workerdeck/protocol'

export type CostFigures = {
  byModel?: ByModel
  reportedCostUsd?: number
}

// `lifetime` is the share of the totals reported by the engine process alive at snapshot time, which is all a
// resumed claude process restores from its transcript; the rest (earlier processes, spend before a clear) it never can.
export type CostLedgerState = CostFigures & {
  lifetime?: CostFigures
}

type Bucket = {
  byModel: ByModel
  reportedUsd: number | undefined
}

function emptyBucket(): Bucket {
  return { byModel: {}, reportedUsd: undefined }
}

function bucketOf(figures: CostFigures): Bucket {
  return { byModel: figures.byModel ?? {}, reportedUsd: figures.reportedCostUsd }
}

function figuresOf(bucket: Bucket): CostFigures {
  return { byModel: Object.keys(bucket.byModel).length === 0 ? undefined : bucket.byModel, reportedCostUsd: bucket.reportedUsd }
}

function addBuckets(into: Bucket, add: Bucket): Bucket {
  const reportedUsd =
    into.reportedUsd === undefined && add.reportedUsd === undefined ? undefined : (into.reportedUsd ?? 0) + (add.reportedUsd ?? 0)
  return { byModel: mergeByModel(into.byModel, add.byModel), reportedUsd }
}

function subtractUsage(from: TokenUsage, part: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, from.input - part.input),
    output: Math.max(0, from.output - part.output),
    cacheWrite5m: Math.max(0, from.cacheWrite5m - part.cacheWrite5m),
    cacheWrite1h: Math.max(0, from.cacheWrite1h - part.cacheWrite1h),
    cacheRead: Math.max(0, from.cacheRead - part.cacheRead),
  }
}

function subtractBuckets(from: Bucket, part: Bucket): Bucket {
  const byModel: ByModel = {}
  for (const [model, usage] of Object.entries(from.byModel)) {
    const taken = part.byModel[model]
    const rest = taken ? subtractUsage(usage, taken) : usage
    if (totalTokens(rest) > 0) {
      byModel[model] = rest
    }
  }
  const reportedUsd = from.reportedUsd === undefined ? undefined : Math.max(0, from.reportedUsd - (part.reportedUsd ?? 0))
  return { byModel, reportedUsd }
}

function isEmpty(bucket: Bucket): boolean {
  return byModelTotalTokens(bucket.byModel) === 0 && !((bucket.reportedUsd ?? 0) > 0)
}

function canonicalByModel(byModel: ByModel): ByModel {
  const out: ByModel = {}
  for (const [model, usage] of Object.entries(byModel)) {
    const key = canonicalModel(model)
    out[key] = addTokenUsage(out[key] ?? emptyTokenUsage(), usage)
  }
  return out
}

function coversUsage(have: TokenUsage, need: TokenUsage): boolean {
  return (
    have.input >= need.input &&
    have.output >= need.output &&
    have.cacheWrite5m >= need.cacheWrite5m &&
    have.cacheWrite1h >= need.cacheWrite1h &&
    have.cacheRead >= need.cacheRead
  )
}

// A running total the engine restored from its transcript is the baseline plus new spend, so it is at least the
// baseline on every model and every token field at once. A process that started from zero clears that bar only
// when one turn outspends the whole earlier lifetime on every field, which the figures cannot tell apart.
function covers(reading: Bucket, baseline: Bucket): boolean {
  let compared = false
  if (baseline.reportedUsd !== undefined && reading.reportedUsd !== undefined) {
    if (reading.reportedUsd < baseline.reportedUsd) {
      return false
    }
    compared = true
  }
  if (byModelTotalTokens(reading.byModel) > 0 && byModelTotalTokens(baseline.byModel) > 0) {
    const have = canonicalByModel(reading.byModel)
    for (const [model, need] of Object.entries(canonicalByModel(baseline.byModel))) {
      if (totalTokens(need) === 0) {
        continue
      }
      const got = have[model]
      if (!got || !coversUsage(got, need)) {
        return false
      }
    }
    compared = true
  }
  return compared
}

// An engine process counts from zero. A session outlives its engine process, through a dormant wake, a rebuild
// after a park, and a mid-session context clear, so a figure that is cumulative *for the process* has to be
// folded into a carried baseline at every one of those boundaries or the session's total silently restarts.
export class CostLedger {
  #carried = emptyBucket()
  #pending: Bucket | undefined
  #current = emptyBucket()

  carry(state: CostLedgerState | undefined): void {
    if (!state) {
      return
    }
    this.#carried = addBuckets(this.#carried, bucketOf(state))
  }

  // Claude restores the total its transcript saved, when the transcript has one, and counts from zero otherwise.
  // The restorable share waits for the first cumulative reading and is dropped if that reading already covers it.
  // Decided once: within one process the reading only grows, so a later comparison would absorb unrestored spend.
  carryUnlessRestored(state: CostLedgerState | undefined): void {
    if (!state) {
      return
    }
    const whole = bucketOf(state)
    const lifetime = state.lifetime ? bucketOf(state.lifetime) : whole
    if (state.lifetime) {
      this.#carried = addBuckets(this.#carried, subtractBuckets(whole, lifetime))
    }
    this.#pending = addBuckets(this.#pending ?? emptyBucket(), lifetime)
  }

  observeCumulative(byModel: ByModel | undefined, reportedCostUsd: number | undefined): void {
    const reading: Bucket = { byModel: byModel ?? {}, reportedUsd: reportedCostUsd }
    if (this.#pending && !isEmpty(reading)) {
      if (!covers(reading, this.#pending)) {
        this.#carried = addBuckets(this.#carried, this.#pending)
      }
      this.#pending = undefined
    }
    if (byModel !== undefined) {
      this.#current = { ...this.#current, byModel }
    }
    if (reportedCostUsd !== undefined) {
      this.#current = { ...this.#current, reportedUsd: reportedCostUsd }
    }
  }

  observeDelta(byModel: ByModel): void {
    this.#current = { ...this.#current, byModel: mergeByModel(this.#current.byModel, byModel) }
  }

  rollover(): void {
    this.#carried = addBuckets(this.#carried, this.#lifetime())
    this.#pending = undefined
    this.#current = emptyBucket()
  }

  get byModel(): ByModel | undefined {
    return figuresOf(this.#total()).byModel
  }

  get breakdown(): CostBreakdown {
    return costOfByModel(this.byModel ?? {})
  }

  get costUsd(): number | undefined {
    const byModel = this.byModel
    if (!byModel) {
      return undefined
    }
    const cost = costOfByModel(byModel)
    return cost.unpriced ? undefined : cost.total
  }

  get reportedCostUsd(): number | undefined {
    return this.#total().reportedUsd
  }

  snapshot(): CostLedgerState {
    return { ...figuresOf(this.#total()), lifetime: figuresOf(this.#lifetime()) }
  }

  #lifetime(): Bucket {
    return addBuckets(this.#pending ?? emptyBucket(), this.#current)
  }

  #total(): Bucket {
    return addBuckets(this.#carried, this.#lifetime())
  }
}
