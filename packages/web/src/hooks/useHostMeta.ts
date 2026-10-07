import { useEffect, useState } from 'react'
import type { GatewayAgentDefaults, GatewayMeta, HostRelays } from '@workerdeck/protocol'
import { clientFor, useHosts } from '../lib/hosts.ts'

const REFRESH_MS = 60_000

export type HostMeta = {
  relays: HostRelays
  agentDefaults: Readonly<Record<string, GatewayAgentDefaults | undefined>>
}

// The operator-only half of each gateway's `/meta`: its relay identity, which lets a team span two configured
// gateways, and what a new agent there defaults to.
export function useHostMeta(): HostMeta {
  const { hosts } = useHosts()
  const [meta, setMeta] = useState<HostMeta>({ relays: {}, agentDefaults: {} })
  const ids = hosts.map((host) => host.id).join('\0')
  useEffect(() => {
    let live = true
    const load = async () => {
      const entries = await Promise.all(
        ids
          .split('\0')
          .filter(Boolean)
          .map(
            async (id) =>
              [
                id,
                await clientFor(id)
                  ?.meta()
                  .catch((): GatewayMeta | undefined => undefined),
              ] as const,
          ),
      )
      if (live) {
        setMeta({
          relays: Object.fromEntries(entries.map(([id, answer]) => [id, answer?.relay])),
          agentDefaults: Object.fromEntries(entries.map(([id, answer]) => [id, answer?.agents])),
        })
      }
    }
    void load()
    const timer = setInterval(() => void load(), REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [ids])
  return meta
}
