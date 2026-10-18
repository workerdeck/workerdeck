import { useEffect, useState } from 'react'
import { errorMessage, type AgentConversationsResponse, type RetiredAgentInfo } from '@workerdeck/protocol'
import { Dialog, DialogBody, DialogContent, DialogHeader, conversationDate, conversationRowText, cn } from '@workerdeck/ui'
import { clientFor, currentHosts } from '@/lib/hosts.ts'

export type ConversationsTarget = { hostId: string; agentId: string; name: string; deleted?: boolean }

type Row = AgentConversationsResponse['conversations'][number]

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T }

export function ConversationsDialog({
  target,
  onClose,
  onOpen,
}: {
  target?: ConversationsTarget
  onClose: () => void
  onOpen: (target: ConversationsTarget, row: Row) => void
}) {
  return (
    <Dialog open={target !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader
          title={target ? `${target.name}: conversations` : 'Conversations'}
          description={target?.deleted ? 'Deleted agent: every conversation opens read-only' : 'Past conversations open read-only'}
        />
        <DialogBody>
          {target ? <ConversationList key={`${target.hostId}:${target.agentId}`} target={target} onOpen={onOpen} /> : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function ConversationList({ target, onOpen }: { target: ConversationsTarget; onOpen: (target: ConversationsTarget, row: Row) => void }) {
  const [loaded, setLoaded] = useState<Loaded<Row[]>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    const client = clientFor(target.hostId)
    if (!client) {
      setLoaded({ state: 'error', message: 'That gateway is not configured here' })
      return
    }
    client
      .agentConversations(target.agentId)
      .then((answer) => live && setLoaded({ state: 'ready', value: answer.conversations }))
      .catch((e: unknown) => live && setLoaded({ state: 'error', message: errorMessage(e, 'Could not list the conversations') }))
    return () => {
      live = false
    }
  }, [target.hostId, target.agentId])

  if (loaded.state !== 'ready') {
    return <p className="text-body-sm text-fg-3">{loaded.state === 'loading' ? 'Loading…' : loaded.message}</p>
  }
  if (loaded.value.length === 0) {
    return <p className="text-body-sm text-fg-3">No conversations yet.</p>
  }
  return (
    <ul className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
      {loaded.value.map((row) => {
        const text = conversationRowText({ ...row, title: row.title ?? row.session?.title })
        return (
          <li key={row.sessionId}>
            <button
              type="button"
              onClick={() => onOpen(target, row)}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-row-hover"
            >
              <span className="flex items-center gap-2 text-body-sm">
                <span className={cn('min-w-0 flex-1 truncate', text.current ? 'font-medium text-fg-1' : 'text-fg-2')}>{text.title}</span>
                {text.current && !target.deleted ? (
                  <span className="shrink-0 rounded-sm bg-accent/15 px-1.5 text-label text-accent">current</span>
                ) : null}
              </span>
              <span className="text-label text-fg-4">{[text.date, text.duration].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

type RetiredRow = { hostId: string; hostName: string; agent: RetiredAgentInfo }

export function PastAgentsDialog({
  open,
  onClose,
  onPick,
}: {
  open: boolean
  onClose: () => void
  onPick: (target: ConversationsTarget) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="md">
        <DialogHeader title="Past agents" description="Deleted agents keep their conversations here" />
        <DialogBody>{open ? <PastAgentList onPick={onPick} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  )
}

function PastAgentList({ onPick }: { onPick: (target: ConversationsTarget) => void }) {
  const [loaded, setLoaded] = useState<Loaded<RetiredRow[]>>({ state: 'loading' })
  useEffect(() => {
    let live = true
    const hosts = currentHosts()
    void Promise.all(
      hosts.map(async (host) => {
        const retired =
          (await clientFor(host.id)
            ?.retiredAgents()
            .catch((): RetiredAgentInfo[] => [])) ?? []
        return retired.map((agent) => ({ hostId: host.id, hostName: host.name, agent }))
      }),
    ).then((lists) => {
      if (live) {
        setLoaded({ state: 'ready', value: lists.flat().sort((a, b) => b.agent.retiredAt - a.agent.retiredAt) })
      }
    })
    return () => {
      live = false
    }
  }, [])

  if (loaded.state !== 'ready') {
    return <p className="text-body-sm text-fg-3">{loaded.state === 'loading' ? 'Loading…' : loaded.message}</p>
  }
  if (loaded.value.length === 0) {
    return <p className="text-body-sm text-fg-3">No deleted agents.</p>
  }
  const many = new Set(loaded.value.map((row) => row.hostId)).size > 1
  return (
    <ul className="-mx-2 flex max-h-[60vh] flex-col overflow-y-auto">
      {loaded.value.map(({ hostId, hostName, agent }) => {
        const count = Math.max(agent.conversations.length, agent.pastSessions.length)
        return (
          <li key={`${hostId}:${agent.id}`}>
            <button
              type="button"
              onClick={() => onPick({ hostId, agentId: agent.id, name: agent.name, deleted: true })}
              className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-row-hover"
            >
              <span className="truncate text-body-sm text-fg-1">{agent.name}</span>
              <span className="text-label text-fg-4">
                {[
                  `Deleted ${conversationDate(agent.retiredAt)}`,
                  `${count} conversation${count === 1 ? '' : 's'}`,
                  many ? hostName : undefined,
                  agent.owner ? `owner ${agent.owner}` : undefined,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
