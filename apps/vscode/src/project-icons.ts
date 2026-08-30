import type { SessionInfo } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'

/**
 * Project icon bytes, resolved host-side and handed to the sidebar as data URLs.
 *
 * The host fetches them because the sidebar webview's CSP has no external
 * `connect-src`: an `<img src>` pointed at a gateway cannot load. Keyed by the
 * icon's own content hash and cached forever — a hash names its bytes, so an entry
 * can never go stale and editing an icon arrives as a new key. Failures are cached
 * too: the route's 404 is the uniform "no icon", and retrying it would be a request
 * per session per poll for a picture that is never coming.
 */
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

  /** Every hash resolved so far — what the webview renders `<img src>` from. */
  entries(): Record<string, string> {
    return Object.fromEntries(this.#byHash)
  }

  /**
   * Note what this state needs and fetch whatever is missing, in the background.
   * Called on every state push; resolutions arrive later via `onResolve`, never by
   * making the caller wait — a gateway that has gone away must not stall the poll.
   */
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
      // The gateway caps these at 512 KiB; a data URL of that is ~683 KiB, sent once per icon.
      this.#byHash.set(hash, `data:${mediaType};base64,${bytes.toString('base64')}`)
      this.#onResolve()
    } catch {
      // Any refusal is the uniform "no icon" — never retried, never surfaced.
      this.#failed.add(hash)
    } finally {
      this.#inFlight.delete(hash)
    }
  }
}
