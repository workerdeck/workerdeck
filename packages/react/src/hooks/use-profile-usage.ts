import { useCallback, useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'
import type { ProfileUsage } from '@workerdeck/protocol'

export type UseProfileUsageOptions = {
  /** How often to re-ask while enabled. Default 60s. */
  intervalMs?: number
  /** Set false to hold the poll — a panel that is off screen has nothing to
   * refresh. Default true. */
  enabled?: boolean
}

export type UseProfileUsageResult = {
  /** The gateway's plan-usage state for this profile, or undefined when there
   * is none to have: no profile, an older gateway, or nothing reported yet.
   * Absent is **unknown, never 0%** — see `ProfileUsageWindow`. */
  usage: ProfileUsage | undefined
  /** Ask again now. */
  refresh: () => void
}

/**
 * The gateway's per-profile plan usage, over REST. A **poll**, never a second attach: nothing
 * pushes account-wide usage (a session's own `rate_limit` readings land only at a turn's edges),
 * and the bridge asks the first attached client, so a second socket per surface is forbidden.
 * Self-disabling on a 404, like {@link useHostFileSearch}.
 */
export const useProfileUsage = (
  client: WorkerDeckClient,
  profile: string | undefined,
  options: UseProfileUsageOptions = {},
): UseProfileUsageResult => {
  const { intervalMs = 60_000, enabled = true } = options
  const [usage, setUsage] = useState<ProfileUsage | undefined>()
  const [unsupported, setUnsupported] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // The previous profile's reading must not stand under a new one — it is
  // another account's plan, not a stale view of this one.
  useEffect(() => setUsage(undefined), [client, profile])

  const alive = useAliveRef()

  useEffect(() => {
    if (!profile || !enabled || unsupported) {
      return
    }
    let cancelled = false
    const load = () => {
      // A hidden tab's meters are not being read; skip the tick rather than
      // keep a background timer talking to the gateway. Read off `globalThis`
      // rather than the global `document`, because this package is typechecked
      // without the DOM lib in the extras project (smoke/, examples/).
      if ((globalThis as { document?: { hidden?: boolean } }).document?.hidden) {
        return
      }
      client
        .listProfiles()
        .then((res) => {
          if (cancelled || !alive.current) {
            return
          }
          setUsage(res.profiles.find((p) => p.name === profile)?.usage)
        })
        .catch((e: unknown) => {
          if (cancelled || !alive.current) {
            return
          }
          if (isRouteUnsupported(e)) {
            setUnsupported(true)
          }
          // Anything else is a blip: keep the last reading, which is dated, and
          // try again on the next tick. Dropping it would replace a known-old
          // number with nothing at all.
        })
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, profile, enabled, unsupported, intervalMs, nonce])

  return { usage, refresh }
}
