import { useEffect, useMemo, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { archivedView, isHistorical, type ArchivedView, type SessionAddress, type SessionInfo } from '@workerdeck/protocol'

type Current = { conversation?: number; retired?: boolean }

// A past conversation's banner: when it ran, and the session's current conversation to go back to, read once per address.
export function useArchivedView(
  client: WorkerDeckClient,
  address: SessionAddress | undefined,
  info: Pick<SessionInfo, 'transcript' | 'createdAt'> | undefined,
): ArchivedView | undefined {
  const [current, setCurrent] = useState<Current | undefined>()
  const id = address?.id
  const conversation = address?.conversation
  const historical = isHistorical(address)

  useEffect(() => {
    setCurrent(undefined)
    if (!historical || id === undefined) {
      return
    }
    let live = true
    client
      .conversations(id)
      .then((list) => live && setCurrent(list.conversation === undefined ? { retired: true } : { conversation: list.conversation }))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, id, historical])

  return useMemo(
    () => (id === undefined ? undefined : archivedView({ id, ...(conversation === undefined ? {} : { conversation }) }, info, current)),
    [id, conversation, info, current],
  )
}

export function conversationReadOnly(readOnly: boolean, address: SessionAddress | undefined): boolean {
  return readOnly || isHistorical(address)
}
