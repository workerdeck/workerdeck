import { join } from 'node:path'
import type { AgentInfo } from '@workerdeck/protocol'
import { readJsonOrSync, writeJsonAtomicSync } from '../lib/atomic-file.ts'

// Store-only fields, stripped from every `AgentInfo`: `schema` marks the record layout (`AGENT_SCHEMA`), `pendingJoin` is a
// remote join the lead may already have accepted, and `roster` versions the team this agent leads. The row's id is the
// session's id.
export type StoredAgent = Omit<AgentInfo, 'sessionId' | 'pastSessions' | 'conversations' | 'undelivered' | 'startFailed'> & {
  avatarSeed: string
  // Set on a retired agent's tombstone: kept for its conversation history, outside every active lookup.
  retiredAt?: number
  avatarRecipe?: unknown
  schema?: number
  pendingJoin?: { op: string; lead: string; at: number }
  roster?: { epoch: string; rev: number; digest: string }
}

export const AGENT_SCHEMA = 1

// Old rows share schema numbers with new ones, so they are told apart by shape: only a pre-4.0 row carries these.
export function isPreMergeAgent(agent: object): boolean {
  return 'sessionId' in agent || 'pastSessions' in agent
}

export type AgentStoreChanges = { saves: StoredAgent[]; deletes: string[] }

// `apply` is one atomic write: every save and delete of a change lands together or not at all.
export type AgentStore = {
  list(): StoredAgent[] | Promise<StoredAgent[]>
  apply(changes: AgentStoreChanges): void | Promise<void>
}

export function createMemoryAgentStore(seed: StoredAgent[] = []): AgentStore {
  const agents = new Map(seed.map((a) => [a.id, a]))
  return {
    list: () => [...agents.values()],
    apply: ({ saves, deletes }) => {
      for (const agent of saves) {
        agents.set(agent.id, agent)
      }
      for (const id of deletes) {
        agents.delete(id)
      }
    },
  }
}

export function createFileAgentStore(path = join(process.cwd(), '.workerdeck', 'agents.json')): AgentStore {
  const read = (): Map<string, StoredAgent> => {
    const parsed = readJsonOrSync(path, [])
    if (!Array.isArray(parsed)) {
      return new Map()
    }
    const agents = parsed as StoredAgent[]
    return new Map(agents.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string').map((a) => [a.id, a]))
  }
  const write = (agents: Map<string, StoredAgent>): void => writeJsonAtomicSync(path, [...agents.values()], { indent: 2 })
  return {
    list: () => [...read().values()],
    apply: ({ saves, deletes }) => {
      const agents = read()
      for (const agent of saves) {
        agents.set(agent.id, agent)
      }
      for (const id of deletes) {
        agents.delete(id)
      }
      write(agents)
    },
  }
}
