import type { SessionInfo } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'

export class ProjectIconCache {
  readonly #store: HostStore
  readonly #onResolve: () => void
  readonly #byHash = new Map<string, string>()
  readonly #inFlight = new Set<string>()
  readonly #failed = new Set<string>()

  constructor(store: HostStore, onResolve: () => void) {
    this.#store = store
    this.#onResolve = onResolve
  }

  entries(): Record<string, string> {
    return Object.fromEntries(this.#byHash)
  }

  ensure(sessions: Record<string, SessionInfo[]>): void {
    for (const [hostId, infos] of Object.entries(sessions)) {
      for (const info of infos) {
        const icon = info.project?.icon
        if (icon?.type !== 'image') {
          continue
        }
        const { hash } = icon
        if (this.#byHash.has(hash) || this.#inFlight.has(hash) || this.#failed.has(hash)) {
          continue
        }
        this.#inFlight.add(hash)
        void this.#fetch(hostId, info.id, hash, icon.mediaType)
      }
    }
  }

  async #fetch(hostId: string, sessionId: string, hash: string, mediaType: string): Promise<void> {
    try {
      const host = this.#store.get(hostId)
      const client = host ? await clientFor(this.#store, host) : undefined
      // An unreachable gateway is not an iconless one: no failure recorded, so the next poll retries.
      if (!client) {
        return
      }
      const blob = await client.projectIcon(sessionId)
      const bytes = Buffer.from(await blob.arrayBuffer())
      this.#byHash.set(hash, `data:${mediaType};base64,${bytes.toString('base64')}`)
      this.#onResolve()
    } catch {
      this.#failed.add(hash)
    } finally {
      this.#inFlight.delete(hash)
    }
  }
}
