import type { WorkerDeckClient } from '@workerdeck/client'
import type { ProfileUsage } from '@workerdeck/protocol'

/**
 * Last known profile usage, kept outside React so a session switch does not blank it.
 *
 * Usage belongs to the *account*, not the session, but it is fetched by a hook that lives inside the per-session
 * panel — so remounting that panel used to drop the authoritative reading to `undefined` for a whole round trip,
 * leaving only the newly-attached session's own replayed (and possibly days-old) numbers to render. That is the
 * "switching sessions resets my weekly usage to 1%, then it catches up" report.
 *
 * Keyed by client identity + profile because a different profile is a different account's plan, never a stale view
 * of this one. Same shape and reasoning as `transcript-cache.ts` next door.
 */
const entries = new Map<string, ProfileUsage>()

// NUL separates unambiguously: `identityKey` is JSON.stringify output, so no two pairs spell one key.
export function profileUsageCacheKey(client: WorkerDeckClient, profile: string): string {
  return `${client.identityKey}\u0000${profile}`
}

export function readProfileUsageCache(key: string): ProfileUsage | undefined {
  return entries.get(key)
}

export function writeProfileUsageCache(key: string, usage: ProfileUsage | undefined): void {
  if (usage === undefined) {
    return
  }
  entries.set(key, usage)
}

export function clearProfileUsageCache(): void {
  entries.clear()
}
