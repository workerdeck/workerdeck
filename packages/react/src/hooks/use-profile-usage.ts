import { useCallback, useEffect, useRef, useState } from 'react'
import { WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
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
 * The gateway's per-profile plan usage, over REST.
 *
 * The session's own event stream carries a `rate_limit` reading only when the
 * engine volunteers one — for claude that is at a turn's edges and nowhere else,
 * so a session idle since yesterday replays yesterday's number, and a session
 * opened today knows nothing of what a sibling on the same account spent an hour
 * ago. `GET /profiles` answers the account-wide question, which is why this is a
 * poll and not a subscription: nothing pushes it.
 *
 * Polling and not attaching, deliberately — a second WebSocket per surface is
 * exactly what the bridge's "asks the first attached client" rule forbids, and
 * this is one small GET a minute.
 *
 * Self-disabling on a 404, like {@link useHostFileSearch}: a gateway without the
 * route will never grow one mid-session, so stop asking rather than log a miss
 * every minute.
 */
export function useProfileUsage(
  client: WorkerDeckClient,
  profile: string | undefined,
  options: UseProfileUsageOptions = {},
): UseProfileUsageResult {
  const { intervalMs = 60_000, enabled = true } = options
  const [usage, setUsage] = useState<ProfileUsage | undefined>()
  const [unsupported, setUnsupported] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // The previous profile's reading must not stand under a new one — it is
  // another account's plan, not a stale view of this one.
  useEffect(() => setUsage(undefined), [client, profile])

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

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
          if (e instanceof WorkerDeckError && e.status === 404) {
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
