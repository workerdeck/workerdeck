import { join } from 'node:path'
import type { AgentInfo } from '@workerdeck/protocol'
import { readJsonOrSync, writeJsonAtomicSync } from '../lib/atomic-file.ts'

export type StoredAgent = AgentInfo & { avatarSeed: string; avatarRecipe?: unknown }

export type AgentStore = {
  list(): StoredAgent[] | Promise<StoredAgent[]>
  save(agent: StoredAgent): void | Promise<void>
  delete(id: string): void | Promise<void>
}

export function createMemoryAgentStore(seed: StoredAgent[] = []): AgentStore {
  const agents = new Map(seed.map((a) => [a.id, a]))
  return {
    list: () => [...agents.values()],
    save: (agent) => void agents.set(agent.id, agent),
    delete: (id) => void agents.delete(id),
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
    save: (agent) => {
      const agents = read()
      agents.set(agent.id, agent)
      write(agents)
    },
    delete: (id) => {
      const agents = read()
      if (agents.delete(id)) {
        write(agents)
      }
    },
  }
}
