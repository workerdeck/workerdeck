import { useEffect, useMemo, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { archivedView, type AgentInfo, type ArchivedView, type SessionInfo, type SessionStatus } from '@workerdeck/protocol'
import { needsArchiveCheck, shownSession } from '../lib/conversation-follow.ts'

export type ArchivedConversation = {
  session: SessionInfo | undefined
  view: ArchivedView | undefined
}

// `agents` stays undefined for a caller that may not list agents (a scoped key): the banner then never says "deleted".
export function useArchivedView(
  client: WorkerDeckClient,
  live: SessionInfo | undefined,
  status: SessionStatus | undefined,
): ArchivedConversation {
  const [reread, setReread] = useState<SessionInfo | undefined>()
  const [agents, setAgents] = useState<AgentInfo[] | undefined>()
  const sessionId = live?.id
  const check = needsArchiveCheck(live, status)

  useEffect(() => {
    setReread(undefined)
  }, [client, sessionId])

  useEffect(() => {
    if (!check || sessionId === undefined) {
      return
    }
    let current = true
    client
      .getSession(sessionId)
      .then((info) => current && info.archived === true && setReread(info))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, sessionId, check])

  const session = shownSession(live, reread)
  const archived = session?.archived === true
  useEffect(() => {
    if (!archived) {
      return
    }
    let current = true
    client
      .listAgents()
      .then((list) => current && setAgents(list))
      .catch(() => {})
    return () => {
      current = false
    }
  }, [client, archived, session?.id])

  const view = useMemo(() => (session ? archivedView(session, agents) : undefined), [session, agents])
  return { session, view }
}
