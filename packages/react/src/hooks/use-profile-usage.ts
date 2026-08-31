import { useCallback, useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'
import type { ProfileUsage } from '@workerdeck/protocol'

export type UseProfileUsageOptions = {
  intervalMs?: number
  enabled?: boolean
}

export type UseProfileUsageResult = {
  usage: ProfileUsage | undefined
  refresh: () => void
}

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

  // A previous profile's reading is another account's plan, not a stale view of this one.
  useEffect(() => setUsage(undefined), [client, profile])

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
          setUsage(res.profiles.find((p) => p.name === profile)?.usage)
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
  }, [client, profile, enabled, unsupported, intervalMs, nonce])

  return { usage, refresh }
}
