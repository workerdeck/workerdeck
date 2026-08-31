import type { Runner } from '@workerdeck/core'
import type { ProfileUsage, ProfileUsageWindow, RateLimitInfo } from '@workerdeck/protocol'

/** A reading as held: what the engine said, and the event clock it said it at. */
type HeldWindow = { info: RateLimitInfo; updatedAt: number }

/**
 * The gateway's single plan-usage state per profile — the account boundary — fed from every
 * session's `rate_limit` events and served as `ProfileInfo.usage`.
 *
 * Last-write-wins by the **event's own `ts`, never arrival order**, because `watch()` subscribes
 * from seq 0 and a rebuilt session's replayed reading must not clobber a live one. In-memory:
 * absent is unknown, never 0%. See `docs/PACKAGES.md` §`packages/server`.
 */
export class ProfileUsageTracker {
  /** profile name → rateLimitType → newest reading. */
  #profiles = new Map<string, Map<string, HeldWindow>>()

  /** Follow a runner's `rate_limit` events for its lifetime. Sessions without a
   * profile have no account to attribute usage to and are skipped. */
  watch(runner: Runner): void {
    const profile = runner.info().profile
    if (!profile) {
      return
    }
    runner.subscribe((event) => {
      if (event.type !== 'rate_limit') {
        return
      }
      const type = event.info.rateLimitType
      if (!type) {
        return
      }
      let windows = this.#profiles.get(profile)
      if (!windows) {
        this.#profiles.set(profile, (windows = new Map()))
      }
      const held = windows.get(type)
      if (held && held.updatedAt > event.ts) {
        return
      }
      // Whole-reading replacement, mirroring the transcript reducer — a newer
      // event is the newer truth even where it carries fewer fields.
      windows.set(type, { info: event.info, updatedAt: event.ts })
    })
  }

  /**
   * The profile's windows as they should be served *now*. Undefined until a session has reported.
   *
   * The 0%-after-reset inference lives here — at **serve time** — and nowhere else, because it is
   * a function of the wall clock: a fabricated `rate_limit` event would be replayed from
   * transcripts forever as if reported. The held reading stays untouched (a late fresh report
   * still lands by ts) and the served zero is labeled `inferredReset` — a floor, not a report.
   */
  usage(profile: string, now = Date.now()): ProfileUsage | undefined {
    const windows = this.#profiles.get(profile)
    if (!windows || windows.size === 0) {
      return undefined
    }
    const out: ProfileUsage = {}
    for (const [type, held] of windows) {
      out[type] = serveWindow(held, now)
    }
    return out
  }
}

/** `resetsAt` is epoch **seconds** (protocol contract); `now` is epoch ms. */
const serveWindow = (held: HeldWindow, now: number): ProfileUsageWindow => {
  const resetsAt = held.info.resetsAt
  if (resetsAt !== undefined && resetsAt * 1000 <= now) {
    return {
      info: {
        // A rolled window is not rejecting anyone, whatever the last reading's
        // status said; `resetsAt`/`isUsingOverage` describe the previous window
        // and are dropped rather than served as facts about this one.
        status: 'allowed',
        rateLimitType: held.info.rateLimitType,
        utilization: 0,
      },
      updatedAt: held.updatedAt,
      inferredReset: true,
    }
  }
  return { info: held.info, updatedAt: held.updatedAt }
}
