import { useCallback, useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'
import { profileUsageCacheKey, readProfileUsageCache, writeProfileUsageCache } from '../lib/profile-usage-cache.ts'
import type { ProfileUsage } from '@workerdeck/protocol'

export type UseProfileUsageOptions = {
  intervalMs?: number
  enabled?: boolean
}

export type UseProfileUsageResult = {
  usage: ProfileUsage | undefined
  refresh: () => void
}

export function useProfileUsage(
  client: WorkerDeckClient,
  profile: string | undefined,
  options: UseProfileUsageOptions = {},
): UseProfileUsageResult {
  const { intervalMs = 60_000, enabled = true } = options
  const cacheKey = profile ? profileUsageCacheKey(client, profile) : undefined
  const [usage, setUsage] = useState<ProfileUsage | undefined>(() => (cacheKey ? readProfileUsageCache(cacheKey) : undefined))
  const [unsupported, setUnsupported] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  // A previous profile's reading is another account's plan, not a stale view of this one — so switch to what we last
  // knew about *this* profile rather than to nothing. Blanking here is what made a session switch fall back on the
  // newly-attached session's own replayed numbers, which is the usage-reverts report.
  useEffect(() => setUsage(cacheKey ? readProfileUsageCache(cacheKey) : undefined), [cacheKey])

  const alive = useAliveRef()

  useEffect(() => {
    if (!profile || !enabled || unsupported) {
      return
    }
    let cancelled = false
    const load = () => {
      // `document` through globalThis: the extras project typechecks this source with no DOM lib.
      if ((globalThis as { document?: { hidden?: boolean } }).document?.hidden) {
        return
      }
      client
        .listProfiles()
        .then((res) => {
          if (cancelled || !alive.current) {
            return
          }
          const next = res.profiles.find((p) => p.name === profile)?.usage
          if (cacheKey) {
            writeProfileUsageCache(cacheKey, next)
          }
          setUsage(next)
        })
        .catch((e: unknown) => {
          if (cancelled || !alive.current) {
            return
          }
          if (isRouteUnsupported(e)) {
            setUnsupported(true)
          }
        })
    }
    load()
    const timer = setInterval(load, intervalMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, profile, enabled, unsupported, intervalMs, nonce, cacheKey])

  return { usage, refresh }
}
