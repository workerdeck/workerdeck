import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionRow } from '@workerdeck/protocol'

/**
 * Project icon bytes as object URLs, keyed by the icon's own content hash and
 * cached module-scope for the life of the page: a hash names its bytes, so an
 * entry can never go stale (an edited icon arrives as a new key), and every
 * surface shares one copy. Failures are cached too — the route's 404 is the
 * uniform "no icon", not worth re-asking every poll. Object URLs are never
 * revoked: they *are* the cache, and revoking one would break every row still
 * pointing at it. The VS Code extension keeps its own copy of this three-set
 * structure (`src/project-icons.ts`) and cannot share this one — its webview
 * has no external `connect-src`, so its bytes arrive as pushed data URLs.
 */
const byHash = new Map<string, string>()
const inFlight = new Set<string>()
const failed = new Set<string>()

export type ClientForHost = (hostId: string) => WorkerDeckClient | undefined

export const useProjectIcons = (rows: readonly SessionRow[], clientFor: ClientForHost): Record<string, string> => {
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
