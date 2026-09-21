import { useEffect, useMemo, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { peerMentionKey, peerMentionSlug, sessionLabel, type SessionInfo } from '@workerdeck/protocol'
import { isRouteUnsupported, useAliveRef } from '../lib/async-guards.ts'

export type PeerSessionOption = {
  id: string
  // What the composer writes after the `#`, and what the gateway folds to resolve it.
  slug: string
  label: string
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

// The other sessions this gateway will show, for the composer's `#` picker. Polled slowly on
// purpose: a name is not a reading, and this list only has to be right when a menu opens. The
// gateway resolves what was typed against the sender's own scope, so a stale row costs nothing
// worse than a mention that stays plain text.
export function usePeerSessions(client: WorkerDeckClient, sessionId: string | undefined, enabled = true): UsePeerSessionsResult {
  const [sessions, setSessions] = useState<SessionInfo[] | undefined>(undefined)
  const [unsupported, setUnsupported] = useState(false)
  const alive = useAliveRef()

  useEffect(() => {
    if (!enabled || unsupported) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = () => {
      client
        .listSessions()
        .then((rows) => {
          if (!alive.current) {
            return
          }
          setSessions(rows)
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
  }, [client, enabled, unsupported])

  return useMemo(() => {
    if (!enabled || unsupported || !sessions) {
      return EMPTY
    }
    const peers = sessions
      .filter((info) => info.id !== sessionId)
      .sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
      .map((info) => ({
        id: info.id,
        slug: peerMentionSlug(info.title, info.id),
        label: sessionLabel(info),
        engine: info.engine,
        status: info.status,
        cwd: info.cwd,
        project: info.project?.name,
        lastActivityAt: info.lastActivityAt,
      }))
    return { available: peers.length > 0, peers, names: peers.map((peer) => peerMentionKey(peer.slug)) }
  }, [enabled, sessionId, sessions, unsupported])
}
