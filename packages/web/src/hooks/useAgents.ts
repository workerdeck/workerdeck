import { useEffect } from 'react'
import type { AgentInfo } from '@workerdeck/protocol'
import { clientFor, currentHosts, onHostsChange } from '../lib/hosts.ts'
import { createPolledStore } from '../lib/store.ts'

const REFRESH_MS = 15_000

// Per gateway; absent where the list could not be read (a scoped key, a gateway down), which is not "no agents".
type State = { byHost: Readonly<Record<string, AgentInfo[] | undefined>> }

const store = createPolledStore<State>({ byHost: {} }, { load: loadAgents, intervalMs: REFRESH_MS })

async function loadAgents(): Promise<void> {
  const entries = await Promise.all(
    currentHosts().map(
      async (host) =>
        [
          host.id,
          await clientFor(host.id)
            ?.listAgents()
            .catch((): AgentInfo[] | undefined => undefined),
        ] as const,
    ),
  )
  store.set({ byHost: Object.fromEntries(entries) })
}

export function refreshAgents(): Promise<void> {
  return store.refresh()
}

export function useAgents() {
  const { byHost } = store.use()
  useEffect(() => onHostsChange(() => void refreshAgents()), [])
  return { byHost, refresh: refreshAgents }
}

export function agentOn(byHost: State['byHost'], hostId: string, agentId: string | undefined): AgentInfo | undefined {
  return agentId === undefined ? undefined : byHost[hostId]?.find((agent) => agent.id === agentId)
}
