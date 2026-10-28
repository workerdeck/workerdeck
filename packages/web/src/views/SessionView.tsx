import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useBookmarks, useSessionInfo } from '@workerdeck/react'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  AgentHeading,
  Badge,
  Button,
  CopyButton,
  toast,
} from '@workerdeck/ui'
import { SessionWorkspace } from '@workerdeck/ui/workspace'
import { Trash2 } from 'lucide-react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { clientFor, useHosts } from '@/lib/hosts.ts'
import { getActionStyle, getCatchUp, getFontSize, getThinking, getTranscriptFont, getTranscriptVariant } from '@/lib/settings.ts'
import { getRail, setRail } from '@/lib/rail.ts'
import { useMarkSeen, unseenSince } from '@/hooks/useUnseen.ts'
import { nudgeSessions, useSessionRows, useSessions } from '@/hooks/useSessions.ts'
import { DeleteAgentDialog, type DeleteAgentTarget } from '@/components/DeleteAgentDialog.tsx'

// Split in two so the inner view takes a *defined* client: a link can outlive the gateway it named, and hooks cannot
// be skipped while we find that out.
export function SessionView() {
  const { hostId, sessionId } = useParams({ from: '/sessions/$hostId/$sessionId' })
  const { ready } = useHosts()
  const navigate = useNavigate()
  const { conversation } = useSearch({ from: '/sessions/$hostId/$sessionId' })
  const client = clientFor(hostId)

  useEffect(() => {
    // Not until the probe has answered: the implicit gateway does not exist at first paint, and bouncing off it here
    // would break every bookmark on the way in.
    if (!ready || client) {
      return
    }
    toast.error('That gateway is not configured here')
    void navigate({ to: '/sessions' })
  }, [ready, client, navigate])

  if (!client) {
    return null
  }
  return (
    <SessionViewInner
      key={`${hostId}:${sessionId}:${conversation ?? ''}`}
      hostId={hostId}
      sessionId={sessionId}
      conversation={conversation}
      client={client}
    />
  )
}

type SessionViewInnerProps = { hostId: string; sessionId: string; conversation?: number; client: WorkerDeckClient }

function SessionViewInner({ hostId, sessionId, conversation, client }: SessionViewInnerProps) {
  const navigate = useNavigate()
  const { subagent, sn, reveal, rn, shell, shn } = useSearch({ from: '/sessions/$hostId/$sessionId' })
  // The workspace asks for this record too and nothing de-dupes, but one small GET beats threading the panel's
  // session state back out through a prop nobody else wants.
  const { info, error } = useSessionInfo(client, sessionId)
  // A past conversation is history: reading it marks nothing about the current one.
  const markSeen = useMarkSeen(hostId, conversation === undefined ? sessionId : undefined)
  const { bookmarks, toggle: toggleBookmark } = useBookmarks(`${hostId}:${sessionId}`)
  // Read once, at mount: re-reading it as the mark moves would walk the catch-up row down the transcript under the reader.
  const [unseen] = useState(() => (getCatchUp() === 'on' && conversation === undefined ? unseenSince(hostId, sessionId) : undefined))
  const [variant] = useState(getTranscriptVariant)
  const [font] = useState(getTranscriptFont)
  const [thinking] = useState(getThinking)
  const [actionStyle] = useState(getActionStyle)
  const [panelFontSize] = useState(getFontSize)
  // Read once: the workspace owns the live value, and re-seeding mid-session would yank the splitter out from under a drag.
  const [rail] = useState(getRail)

  useEffect(() => {
    if (!error) {
      return
    }
    toast.error('Session not found')
    void navigate({ to: '/sessions' })
  }, [error, navigate])

  // State, rather than a read of `document.hidden`: marks are refused while hidden, so with nothing re-running on the
  // way back a session left mid-turn keeps its badge forever.
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // Mark off the same record the badge counts from, the polled sessions list. `onVitals` and `useSessionInfo` both
  // look right here and are not.
  const { snapshots } = useSessions()
  const rows = useSessionRows(snapshots)
  const agentRow = rows.find((row) => row.hostId === hostId && row.info.id === sessionId && row.info.agent)
  const peerRows = useMemo(() => Object.fromEntries(rows.filter((row) => row.hostId === hostId).map((row) => [row.info.id, row])), [rows, hostId])
  const polled = useMemo(
    () => snapshots.find((s) => s.host.id === hostId)?.sessions.find((s) => s.id === sessionId),
    [snapshots, hostId, sessionId],
  )
  useEffect(() => {
    if (!polled || !visible) {
      return
    }
    markSeen({ activity: polled.activityCount, prose: polled.proseCount })
  }, [polled?.activityCount, polled?.proseCount, visible, markSeen])

  const close = async () => {
    try {
      await client.deleteSession(sessionId)
    } catch {}
    void navigate({ to: '/sessions' })
  }

  const [deleting, setDeleting] = useState<DeleteAgentTarget>()
  const project = info?.cwd?.split('/').filter(Boolean).pop()

  return (
    <>
      <SessionWorkspace
        key={sessionId}
        client={client}
        sessionId={sessionId}
        peerRows={peerRows}
        transcriptVariant={variant}
        transcriptFont={font}
        hideThinking={thinking === 'hide'}
        affordances={{ labels: actionStyle === 'labeled' }}
        fontSize={panelFontSize}
        openSubagent={subagent ? { toolUseId: subagent, nonce: sn ?? 0 } : undefined}
        reveal={reveal ? { toolUseId: reveal, nonce: rn ?? 0 } : undefined}
        cwd={polled?.cwd}
        subagents={polled?.subagents}
        // Three rules keep this report → URL → panel round-trip from looping: no-op on match, `sn` rides through
        // unchanged, and `replace` rather than push.
        onSubagentChange={(toolUseId) => {
          if (toolUseId === subagent) {
            return
          }
          void navigate({
            to: '/sessions/$hostId/$sessionId',
            params: { hostId, sessionId },
            search: (prev) => (toolUseId === undefined ? { conversation: prev.conversation } : { subagent: toolUseId, sn: prev.sn, conversation: prev.conversation }),
            replace: true,
          })
        }}
        openShell={shell ? { shellId: shell, nonce: shn ?? 0 } : undefined}
        shells={polled?.shells}
        // The same three rules as the sub-agent pair above, plus: `subagent`/`sn` ride through untouched, so the
        // sub-agent frame reads its own unchanged nonce and stays inert.
        onShellChange={(shellId) => {
          if (shellId === shell) {
            return
          }
          void navigate({
            to: '/sessions/$hostId/$sessionId',
            params: { hostId, sessionId },
            search: (prev) => ({ subagent: prev.subagent, sn: prev.sn, shell: shellId, shn: prev.shn, conversation: prev.conversation }),
            replace: true,
          })
        }}
        scrubber
        bookmarks={bookmarks}
        onToggleBookmark={toggleBookmark}
        stickyPrompt
        statusPlacement="bottom"
        controlsSurface="status"
        defaultRailWidth={rail.width}
        defaultRailCollapsed={rail.collapsed}
        onRailChange={setRail}
        conversation={conversation}
        onGoToCurrent={() =>
          void navigate({
            to: '/sessions/$hostId/$sessionId',
            params: { hostId, sessionId },
            search: {},
          })
        }
        unseen={unseen}
        onVitals={(vitals) => {
          // Only `itemCount` and its conversation: the socket is their sole source, and `activity`/`prose` ride the effect above instead.
          markSeen({ itemCount: vitals.itemCount, conversation: vitals.conversation })
          nudgeSessions()
        }}
        header={({ actions }) => (
          <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
            {agentRow ? (
              <AgentHeading row={agentRow} className="shrink-0" />
            ) : (
              <span className="truncate text-body-sm font-medium text-fg-1">{info?.title ?? project ?? sessionId.slice(0, 8)}</span>
            )}
            {info?.engine && info.engine !== 'claude' ? (
              <Badge variant="neutral" className="shrink-0">
                {info.engine}
              </Badge>
            ) : null}
            {info?.cwd ? (
              <span className="min-w-0 truncate font-mono text-label text-fg-4" title={info.cwd}>
                {info.cwd}
              </span>
            ) : null}
            <span className="flex-1" />
            <CopyButton value={sessionId} aria-label="Copy session id" />
            {conversation !== undefined ? null : info?.agent ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete agent"
                title="Delete agent…"
                onClick={() => setDeleting({ hostId, agentId: info.agent!.id, name: info.agent!.name, conversation: info.conversation ?? 1 })}
              >
                <Trash2 className="size-4 text-fg-3" />
              </Button>
            ) : (
              <AlertDialog>
                <AlertDialogTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="Close session">
                      <Trash2 className="size-4 text-fg-3" />
                    </Button>
                  }
                />
                <AlertDialogContent>
                  <AlertDialogTitle>Close this session?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The run is terminated on the server. You can pick it up later from “Resume a previous session” - the transcript is kept
                    by the engine, not by the gateway.
                  </AlertDialogDescription>
                  <div className="mt-4 flex justify-end gap-2">
                    <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
                    <Button variant="destructive" onClick={() => void close()}>
                      Close session
                    </Button>
                  </div>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {actions}
          </div>
        )}
      />
      <DeleteAgentDialog target={deleting} onClose={() => setDeleting(undefined)} onDeleted={nudgeSessions} />
    </>
  )
}
