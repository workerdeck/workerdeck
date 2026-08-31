import { useEffect, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import type { SessionRow } from '@workerdeck/protocol'

const byHash = new Map<string, string>()
const inFlight = new Set<string>()
const failed = new Set<string>()

export type ClientForHost = (hostId: string) => WorkerDeckClient | undefined

export function useProjectIcons(rows: readonly SessionRow[], clientFor: ClientForHost): Record<string, string> {
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
      // An unreachable gateway is not an iconless one: no failure recorded, so a later render retries.
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
