import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionRow } from '@workerdeck/protocol'

/**
 * Project icon bytes for a list of sessions, as object URLs keyed by the icon's
 * own content hash.
 *
 * **Keyed by hash, and cached for the life of the page.** That is what the
 * wire's `ProjectIcon.image.hash` is for: every session in one project serves
 * identical bytes, so twelve rows of one repo cost one request, and two
 * *different* projects that happen to declare the same file cost one between
 * them. A hash names its bytes, so an entry can never go stale — editing the
 * icon changes the hash, which arrives on the next poll as a key this cache has
 * not seen. The old entry is dead weight rather than a wrong answer, and the
 * population is bounded by how many distinct icons an operator has open.
 *
 * The cache is **module scope on purpose**, like `useSessions`' store: the
 * sidebar and any other surface rendering rows mount this at once, and a
 * per-hook cache would be N copies each fetching the same bytes.
 *
 * A failure is cached as a failure. The route's 404 is the uniform "no icon"
 * (no project, a glyph, or one the gateway refused), so retrying it every poll
 * would be a request per session per poll for a picture that is never coming.
 *
 * Object URLs are never revoked, which is the same decision stated twice: they
 * are the cache. Revoking one would break every row still pointing at it, and
 * the whole point of hashing is that nothing here is ever superseded.
 *
 * The VS Code extension has the same three-set structure in `project-icons.ts`
 * and cannot share this one — its webview has no external `connect-src` at all,
 * so its bytes arrive as data URLs pushed from the extension host. One design,
 * two implementations, for a reason that is in the transport rather than here.
 */
const byHash = new Map<string, string>()
const inFlight = new Set<string>()
const failed = new Set<string>()

export type ClientForHost = (hostId: string) => WorkerDeckClient | undefined

export function useProjectIcons(rows: readonly SessionRow[], clientFor: ClientForHost): Record<string, string> {
  // Held as state rather than read from the map, so a resolution re-renders.
  // The value is a snapshot of the module cache, which is why every consumer
  // sees an icon the moment any of them fetched it.
  const [resolved, setResolved] = useState<Record<string, string>>(() => Object.fromEntries(byHash))

  useEffect(() => {
    let alive = true
    for (const row of rows) {
      const icon = row.info.project?.icon
      if (icon?.type !== 'image') {
        continue
      }
      const { hash } = icon
      if (byHash.has(hash) || inFlight.has(hash) || failed.has(hash)) {
        continue
      }
      const client = clientFor(row.hostId)
      // An unreachable gateway is not an iconless one: fall out without
      // recording a failure, so a later render tries again once it is back.
      if (!client) {
        continue
      }
      inFlight.add(hash)
      void client
        .projectIcon(row.info.id)
        .then((blob) => {
          byHash.set(hash, URL.createObjectURL(blob))
          if (alive) {
            setResolved(Object.fromEntries(byHash))
          }
        })
        .catch(() => {
          // Any refusal is the uniform "no icon" — never retried, never surfaced.
          failed.add(hash)
        })
        .finally(() => inFlight.delete(hash))
    }
    return () => {
      alive = false
    }
  }, [rows, clientFor])

  return resolved
}
