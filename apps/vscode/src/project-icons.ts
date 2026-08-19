import type { SessionInfo } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { HostStore } from './hosts.ts'

/**
 * Project icon bytes, resolved host-side and handed to the sidebar as data
 * URLs, keyed by the icon's own content hash.
 *
 * **Why the host fetches these at all.** The sidebar webview's CSP has no
 * external `connect-src` — the whole point of the transport bridge — so an
 * `<img src>` pointed at a gateway cannot load, with or without a credential.
 * The bytes have to arrive through the extension host, which is where the
 * gateway's key lives anyway (`SecretStorage`, never the webview).
 *
 * **Keyed by hash, not by session or by project.** That is what the wire's
 * `ProjectIcon.image.hash` is for: every session in one project serves
 * identical bytes, so twelve rows of one repo cost one request. Two *different*
 * projects that happen to declare the same icon file cost one between them, and
 * so do two gateways serving the same repo — content addressing makes both fall
 * out for free rather than needing a rule.
 *
 * **Cached forever, deliberately.** A hash names its bytes, so an entry can
 * never go stale: editing the icon changes the hash, which arrives on the next
 * poll as a key this cache has not seen and fetches anew. The old entry is
 * dead weight rather than a wrong answer, and the population is bounded by the
 * number of distinct icons an operator has open — a handful, for the lifetime
 * of a window.
 *
 * **A failure is cached as a failure.** The route's 404 is the uniform "no
 * icon" (no project, a glyph, or an icon the gateway refused), so retrying it
 * every poll would be a request per session per 1.2s for a picture that is
 * never coming. `#failed` is what keeps the miss as cheap as the hit.
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
   *
   * Called on every state push, so the common path is a walk over the rows
   * finding nothing new. Resolutions arrive later via `onResolve`, never by
   * making the caller wait: a list must draw before its pictures do, and a
   * gateway that has gone away must not stall the poll.
   */
  ensure(sessions: Record<string, SessionInfo[]>): void {
    for (const [hostId, infos] of Object.entries(sessions)) {
      for (const info of infos) {
        const icon = info.project?.icon
        if (icon?.type !== 'image') continue
        const { hash } = icon
        if (this.#byHash.has(hash) || this.#inFlight.has(hash) || this.#failed.has(hash)) continue
        this.#inFlight.add(hash)
        void this.#fetch(hostId, info.id, hash, icon.mediaType)
      }
    }
  }

  async #fetch(hostId: string, sessionId: string, hash: string, mediaType: string): Promise<void> {
    try {
      const host = this.#store.get(hostId)
      const client = host ? await clientFor(this.#store, host) : undefined
      // An unreachable gateway is not an iconless one: fall out without
      // recording a failure, so the next poll tries again once it is back.
      if (!client) return
      const blob = await client.projectIcon(sessionId)
      const bytes = Buffer.from(await blob.arrayBuffer())
      // The gateway caps these at 512 KiB and re-checks at serve time; a data
      // URL of that is ~683 KiB, sent once per icon for the life of the window.
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
