import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Runner } from '@workerdeck/core'
import { type ByModel, type ProfileSpend, costOfByModel, mergeByModel, subscriptionComparison } from '@workerdeck/protocol'

export type SpendRecord = { days: Record<string, Record<string, ByModel>> }

export type SpendStore = {
  load(): Promise<SpendRecord | undefined>
  save(record: SpendRecord): Promise<void>
}

export type SpendLedgerOptions = {
  store?: SpendStore
  monthlySubscriptionUsd?: (profile: string) => number | undefined
  retentionDays?: number
  saveDebounceMs?: number
  onError?: (error: unknown) => void
}

const DEFAULT_RETENTION_DAYS = 92

const DEFAULT_SAVE_DEBOUNCE_MS = 2_000

export function dayKey(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBack(now: number, count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i += 1) {
    out.push(dayKey(now - i * 86_400_000))
  }
  return out
}

function subtract(current: ByModel, previous: ByModel): ByModel {
  const delta: ByModel = {}
  for (const [model, usage] of Object.entries(current)) {
    const was = previous[model]
    const row = {
      input: usage.input - (was?.input ?? 0),
      output: usage.output - (was?.output ?? 0),
      cacheWrite5m: usage.cacheWrite5m - (was?.cacheWrite5m ?? 0),
      cacheWrite1h: usage.cacheWrite1h - (was?.cacheWrite1h ?? 0),
      cacheRead: usage.cacheRead - (was?.cacheRead ?? 0),
    }
    // A negative delta means the session's cumulative figure went backwards, which only happens when the reading
    // we diffed against was not this session's. Recording nothing beats recording a negative day.
    if (Object.values(row).some((value) => value < 0)) {
      continue
    }
    if (Object.values(row).some((value) => value > 0)) {
      delta[model] = row
    }
  }
  return delta
}

// `turn_result.usageByModel` is session-cumulative, so the ledger records the difference from what this session
// last contributed. The baseline is seeded from the runner's own info at watch time, which is what keeps a woken
// session's carried spend from being banked a second time as if it had just been earned.
export class SpendLedger {
  #days: Record<string, Record<string, ByModel>> = {}
  #lastBanked = new Map<string, ByModel>()
  #options: SpendLedgerOptions
  #saveTimer: ReturnType<typeof setTimeout> | undefined
  #loaded: Promise<void> | undefined

  constructor(options: SpendLedgerOptions = {}) {
    this.#options = options
  }

  load(): Promise<void> {
    this.#loaded ??= this.#load()
    return this.#loaded
  }

  async #load(): Promise<void> {
    const store = this.#options.store
    if (!store) {
      return
    }
    try {
      const record = await store.load()
      if (record?.days) {
        this.#days = record.days
      }
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  watch(runner: Runner): () => void {
    const info = runner.info()
    const profile = info.profile
    if (!profile) {
      return () => {}
    }
    this.#lastBanked.set(runner.id, info.usageByModel ?? {})
    const unsubscribe = runner.subscribe((event) => {
      if (event.type !== 'turn_result' || !event.usageByModel) {
        return
      }
      this.#bank(profile, event.usageByModel, runner.id, event.ts)
    })
    return () => {
      unsubscribe()
      this.#lastBanked.delete(runner.id)
    }
  }

  #bank(profile: string, cumulative: ByModel, sessionId: string, at: number): void {
    const previous = this.#lastBanked.get(sessionId) ?? {}
    const delta = subtract(cumulative, previous)
    this.#lastBanked.set(sessionId, cumulative)
    if (Object.keys(delta).length === 0) {
      return
    }
    const key = dayKey(at)
    const day = (this.#days[key] ??= {})
    day[profile] = mergeByModel(day[profile] ?? {}, delta)
    this.#scheduleSave()
  }

  spend(profile: string, now = Date.now()): ProfileSpend | undefined {
    const week = this.#window(profile, daysBack(now, 7))
    const month = this.#window(profile, daysBack(now, 30))
    if (Object.keys(month).length === 0) {
      return undefined
    }
    const weekCost = costOfByModel(week)
    const monthlySubscriptionUsd = this.#options.monthlySubscriptionUsd?.(profile)
    return {
      weekUsd: weekCost.total,
      monthUsd: costOfByModel(month).total,
      weekByModel: week,
      unpricedShare: weekCost.unpricedShare,
      monthlySubscriptionUsd,
      subscription: monthlySubscriptionUsd ? subscriptionComparison(weekCost.total, monthlySubscriptionUsd) : undefined,
    }
  }

  #window(profile: string, keys: string[]): ByModel {
    let out: ByModel = {}
    for (const key of keys) {
      const day = this.#days[key]?.[profile]
      if (day) {
        out = mergeByModel(out, day)
      }
    }
    return out
  }

  #scheduleSave(): void {
    if (!this.#options.store || this.#saveTimer) {
      return
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined
      void this.flush()
    }, this.#options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS)
    this.#saveTimer.unref?.()
  }

  async flush(): Promise<void> {
    const store = this.#options.store
    if (!store) {
      return
    }
    this.#prune()
    try {
      await store.save({ days: this.#days })
    } catch (error) {
      this.#options.onError?.(error)
    }
  }

  #prune(): void {
    const keep = new Set(daysBack(Date.now(), this.#options.retentionDays ?? DEFAULT_RETENTION_DAYS))
    for (const key of Object.keys(this.#days)) {
      if (!keep.has(key)) {
        delete this.#days[key]
      }
    }
  }

  close(): void {
    clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
  }
}

export function createFileSpendStore(path: string, onError?: (error: unknown) => void): SpendStore {
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
        if (parsed === null || typeof parsed !== 'object' || typeof (parsed as SpendRecord).days !== 'object') {
          return undefined
        }
        return parsed as SpendRecord
      } catch {
        return undefined
      }
    },
    async save(record) {
      try {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(record))
        await rename(temp, path)
      } catch (error) {
        onError?.(error)
      }
    },
  }
}
