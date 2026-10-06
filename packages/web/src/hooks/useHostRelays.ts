import { useEffect, useState } from 'react'
import type { HostRelays } from '@workerdeck/protocol'
import { clientFor, useHosts } from '../lib/hosts.ts'

const REFRESH_MS = 60_000

// Each gateway's relay identity (`GatewayMeta.relay`, operator-only), which lets a team span two configured gateways.
export function useHostRelays(): HostRelays {
  const { hosts } = useHosts()
  const [relays, setRelays] = useState<HostRelays>({})
  const ids = hosts.map((host) => host.id).join('\0')
  useEffect(() => {
    let live = true
    const load = async () => {
      const entries = await Promise.all(
        ids
          .split('\0')
          .filter(Boolean)
          .map(async (id) => [id, await clientFor(id)?.meta().then((meta) => meta.relay, () => undefined)] as const),
      )
      if (live) {
        setRelays(Object.fromEntries(entries))
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [ids])
  return relays
}
