import { useEffect, useSyncExternalStore } from 'react'
import type { SessionRow } from '@workerdeck/protocol'
import type { AgentAvatarImage, AgentAvatars } from '@workerdeck/ui'
import { clientFor } from '../lib/hosts.ts'

const RETRY_AFTER_MS = 60_000

let avatars: AgentAvatars = {}
const inFlight = new Set<string>()
const failedAt = new Map<string, number>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): AgentAvatars {
  return avatars
}

// Keyed by `AgentRef.avatar`, which is stable per agent (the recipe is rolled once), so each path is fetched once per page.
export function useAgentAvatars(rows: SessionRow[]): AgentAvatars {
  useEffect(() => {
    for (const row of rows) {
      const agent = row.info.agent
      if (agent?.avatar !== undefined) {
        ensure(row.hostId, agent.id, agent.avatar)
      }
    }
  }, [rows])
  return useSyncExternalStore(subscribe, snapshot)
}

function ensure(hostId: string, agentId: string, path: string): void {
  if (avatars[path] || inFlight.has(path) || Date.now() - (failedAt.get(path) ?? -Infinity) < RETRY_AFTER_MS) {
    return
  }
  const client = clientFor(hostId)
  if (!client) {
    return
  }
  inFlight.add(path)
  void (async () => {
    try {
      const still = await client.agentAvatar(agentId)
      const busy = await client.agentAvatar(agentId, true).catch(() => undefined)
      const image: AgentAvatarImage = { still: URL.createObjectURL(still.blob) }
      if (busy?.durations) {
        image.busy = { src: URL.createObjectURL(busy.blob), durations: busy.durations }
      }
      failedAt.delete(path)
      avatars = { ...avatars, [path]: image }
      for (const listener of listeners) {
        listener()
      }
    } catch {
      failedAt.set(path, Date.now())
    } finally {
      inFlight.delete(path)
    }
  })()
}
