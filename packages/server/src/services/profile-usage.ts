import type { Runner } from '@workerdeck/core'
import type { ProfileUsage, ProfileUsageWindow, RateLimitInfo } from '@workerdeck/protocol'

/** A reading as held: what the engine said, and the event clock it said it at. */
type HeldWindow = { info: RateLimitInfo; updatedAt: number }

/**
 * The gateway's single plan-usage state per profile, fed from every session's
 * `rate_limit` events and served on `GET /profiles` (`ProfileInfo.usage`).
 *
 * Why this exists at all: usage had only ever lived in session transcripts, so
 * a client attaching to a session that idled since yesterday replayed
 * yesterday's reading as if current — and a session opened today knew nothing
 * of what a sibling session on the same account spent an hour ago. The profile
 * is the account boundary (one config dir / codex home / provider key = one
 * plan), so the newest reading across all of a profile's sessions is the one
 * usage state that is ever worth showing. No history: last-write-wins per
 * window, exactly the reducer's rule on the client side.
 *
 * Last-write-wins goes by the **event's own clock**, not arrival order:
 * `watch()` subscribes from seq 0 (a replayed log is how a rebuilt session's
 * readings arrive at all), and a replayed yesterday-reading must not clobber
 * the fresher one another session on the same profile reported live. All
 * events are stamped by this gateway's clock at emit time, so the comparison
 * is sound across sessions.
 *
 * In-memory on purpose, like the learned default models and the availability
 * cache: display-only state may start empty after a restart (absent = unknown,
 * never 0%), and the first session to report refills it.
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
   * The profile's windows as they should be served *now*. Undefined until any
   * session on the profile has reported (unknown, never 0%).
   *
   * The 0%-after-reset inference lives here — at serve time — and nowhere
   * else, because it is a function of the wall clock: a window whose own
   * `resetsAt` has passed with no newer reading has provably rolled, so the
   * pre-reset utilization is no longer merely stale but *wrong*. It cannot be
   * a producer's job (the producers only relay what the engine said, and the
   * whole problem is the engine's silence; a fabricated 0% event would be
   * replayed from transcripts forever as if reported) and must not be every
   * renderer's (N clients would each reimplement the clock math). The held
   * reading stays untouched, so a late fresh report still lands by ts, and the
   * served zero is labeled `inferredReset` — it is a floor, not a report: the
   * account may have been used outside this gateway since the reset.
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
function serveWindow(held: HeldWindow, now: number): ProfileUsageWindow {
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
