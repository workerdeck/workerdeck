import { useEffect, useMemo, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { peerMentionKey, peerMentionSlug, type PeerSessionSummary, type SessionInfo } from '@workerdeck/protocol'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'

export type PeerSessionOption = {
  id: string
  // What the composer writes after the `#`, and what the gateway folds to resolve it.
  slug: string
  label: string
  // Set for a session on another gateway, reached through the relay.
  gateway?: string
  engine?: SessionInfo['engine']
  status: SessionInfo['status']
  cwd: string
  project?: string
  lastActivityAt?: number
}

export type UsePeerSessionsResult = {
  available: boolean
  peers: PeerSessionOption[]
  // Folded slugs, for `scanPromptTokens`'s `sessions` allowlist.
  names: string[]
}

const EMPTY: UsePeerSessionsResult = { available: false, peers: [], names: [] }

const IDLE_MS = 20_000

// The sessions this one may address, relay included, for the composer's `#` picker: the same
// directory the gateway resolves a typed name against. Polled slowly on purpose: a name is not a
// reading, and this list only has to be right when a menu opens, so a stale row costs nothing
// worse than a mention that stays plain text.
export function usePeerSessions(client: WorkerDeckClient, sessionId: string | undefined, enabled = true): UsePeerSessionsResult {
  const [rows, setRows] = useState<PeerSessionSummary[] | undefined>(undefined)
  const [unsupported, setUnsupported] = useState(false)
  const alive = useAliveRef()

  useEffect(() => {
    setRows(undefined)
    if (!enabled || unsupported || !sessionId) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      client
        .listPeers(sessionId)
        .then((peers) => {
          if (alive.current) {
            setRows(peers)
          }
        })
        .catch((e: unknown) => {
          if (alive.current && isRouteUnsupported(e)) {
            setUnsupported(true)
          }
        })
        .finally(() => {
          if (alive.current) {
            timer = setTimeout(tick, IDLE_MS)
          }
        })
    }
    tick()
    return () => {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }, [client, enabled, sessionId, unsupported])

  return useMemo(() => {
    if (!enabled || unsupported || !rows) {
      return EMPTY
    }
    const peers = rows.map((row) => ({
      id: row.id,
      slug: peerMentionSlug(row.title, row.id),
      label: row.title ?? peerMentionSlug(undefined, row.id),
      gateway: row.gateway,
      engine: row.engine,
      status: row.status,
      cwd: row.cwd,
      project: row.project,
      lastActivityAt: row.lastActivityAt,
    }))
    return { available: peers.length > 0, peers, names: peers.map((peer) => peerMentionKey(peer.slug)) }
  }, [enabled, rows, unsupported])
}
