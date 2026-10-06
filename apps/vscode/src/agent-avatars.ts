import type { SessionInfo } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'
import type { AgentAvatarImage } from './bridge-protocol.ts'

// Keyed by `AgentRef.avatar`, the gateway path, which is stable per agent: the recipe is rolled once and persisted.
export class AgentAvatarCache {
  readonly #store: HostStore
  readonly #onResolve: () => void
  readonly #byPath = new Map<string, AgentAvatarImage>()
  readonly #inFlight = new Set<string>()
  readonly #failed = new Set<string>()

  constructor(store: HostStore, onResolve: () => void) {
    this.#store = store
    this.#onResolve = onResolve
  }

  entries(): Record<string, AgentAvatarImage> {
    return Object.fromEntries(this.#byPath)
  }

  ensure(sessions: Record<string, SessionInfo[]>): void {
    for (const [hostId, infos] of Object.entries(sessions)) {
      for (const info of infos) {
        const agent = info.agent
        if (!agent?.avatar) {
          continue
        }
        const key = agent.avatar
        if (this.#byPath.has(key) || this.#inFlight.has(key) || this.#failed.has(key)) {
          continue
        }
        this.#inFlight.add(key)
        void this.#fetch(hostId, agent.id, key)
      }
    }
  }

  async #fetch(hostId: string, agentId: string, key: string): Promise<void> {
    try {
      const host = this.#store.get(hostId)
      const client = host ? await clientFor(this.#store, host) : undefined
      if (!client) {
        return
      }
      const still = await client.agentAvatar(agentId)
      const busy = await client.agentAvatar(agentId, true).catch(() => undefined)
      const image: AgentAvatarImage = { still: await dataUrl(still.blob) }
      if (busy?.durations) {
        image.busy = { src: await dataUrl(busy.blob), durations: busy.durations }
      }
      this.#byPath.set(key, image)
      this.#onResolve()
    } catch {
      this.#failed.add(key)
    } finally {
      this.#inFlight.delete(key)
    }
  }
}

async function dataUrl(blob: Blob): Promise<string> {
  return `data:image/png;base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`
}
