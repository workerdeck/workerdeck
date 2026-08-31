import type { Runner } from '@workerdeck/core'
import type { ProfileUsage, ProfileUsageWindow, RateLimitInfo } from '@workerdeck/protocol'

type HeldWindow = { info: RateLimitInfo; updatedAt: number }

export class ProfileUsageTracker {
  #profiles = new Map<string, Map<string, HeldWindow>>()

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
      windows.set(type, { info: event.info, updatedAt: event.ts })
    })
  }

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

// `resetsAt` is epoch seconds (protocol contract); `now` is epoch ms.
function serveWindow(held: HeldWindow, now: number): ProfileUsageWindow {
  const resetsAt = held.info.resetsAt
  if (resetsAt !== undefined && resetsAt * 1000 <= now) {
    return {
      info: {
        // The dropped `resetsAt`/`isUsingOverage` describe the window that rolled, not this one.
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
