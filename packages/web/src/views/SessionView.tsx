import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useSessionInfo } from '@workerdeck/react'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  CopyButton,
  toast,
} from '@workerdeck/ui'
import { SessionWorkspace } from '@workerdeck/ui/workspace'
import { Trash2 } from 'lucide-react'
import type { WorkerDeckClient } from '@workerdeck/client'
import { clientFor, useHosts } from '@/lib/hosts.ts'
import { getFontSize, getTranscriptDensity, getTranscriptFont, getTranscriptVariant } from '@/lib/settings.ts'
import { getRail, setRail } from '@/lib/rail.ts'
import { useMarkSeen, unseenSince } from '@/hooks/useUnseen.ts'
import { nudgeSessions, useSessions } from '@/hooks/useSessions.ts'

// Split in two so the inner view takes a *defined* client: a link can outlive the gateway it named, and hooks cannot
// be skipped while we find that out.
export function SessionView() {
  const { hostId, sessionId } = useParams({ from: '/sessions/$hostId/$sessionId' })
  const { ready } = useHosts()
  const navigate = useNavigate()
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
  return <SessionViewInner key={`${hostId}:${sessionId}`} hostId={hostId} sessionId={sessionId} client={client} />
}

function SessionViewInner({ hostId, sessionId, client }: { hostId: string; sessionId: string; client: WorkerDeckClient }) {
  const navigate = useNavigate()
  const { subagent, sn, reveal, rn } = useSearch({ from: '/sessions/$hostId/$sessionId' })
  // The workspace asks for this record too and nothing de-dupes, but one small GET beats threading the panel's
  // session state back out through a prop nobody else wants.
  const { info, error } = useSessionInfo(client, sessionId)
  const markSeen = useMarkSeen(hostId, sessionId)
  // Read once, at mount: re-reading it as the mark moves would walk the catch-up row down the transcript under the reader.
  const [unseen] = useState(() => unseenSince(hostId, sessionId))
  const [density] = useState(getTranscriptDensity)
  const [variant] = useState(getTranscriptVariant)
  const [font] = useState(getTranscriptFont)
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
  const polled = useMemo(
    () => snapshots.find((s) => s.host.id === hostId)?.sessions.find((s) => s.id === sessionId),
    [snapshots, hostId, sessionId],
  )
  useEffect(() => {
    if (!polled || !visible) {
      return
    }
    markSeen({ activity: polled.activityCount, turns: polled.numTurns })
  }, [polled?.activityCount, polled?.numTurns, visible, markSeen])

  const close = async () => {
    try {
      await client.deleteSession(sessionId)
    } catch {}
    void navigate({ to: '/sessions' })
  }

  const project = info?.cwd?.split('/').filter(Boolean).pop()

  return (
    <SessionWorkspace
      key={sessionId}
      client={client}
      sessionId={sessionId}
      transcriptVariant={variant}
      transcriptDensity={density}
      transcriptFont={font}
      fontSize={panelFontSize}
      openSubagent={subagent ? { toolUseId: subagent, nonce: sn ?? 0 } : undefined}
      reveal={reveal ? { toolUseId: reveal, nonce: rn ?? 0 } : undefined}
      // Three rules keep this report → URL → panel round-trip from looping: no-op on match, `sn` rides through
      // unchanged, and `replace` rather than push.
      onSubagentChange={(toolUseId) => {
        if (toolUseId === subagent) {
          return
        }
        void navigate({
          to: '/sessions/$hostId/$sessionId',
          params: { hostId, sessionId },
          search: toolUseId === undefined ? {} : (prev) => ({ subagent: toolUseId, sn: prev.sn }),
          replace: true,
        })
      }}
      scrubber
      stickyPrompt
      statusPlacement="bottom"
      controlsSurface="status"
      defaultRailWidth={rail.width}
      defaultRailCollapsed={rail.collapsed}
      onRailChange={setRail}
      unseen={unseen}
      onVitals={(vitals) => {
        // Only `itemCount`: the socket is its sole source, and `activity`/`turns` ride the effect above instead.
        markSeen({ itemCount: vitals.itemCount })
        nudgeSessions()
      }}
      header={({ actions }) => (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <span className="truncate text-body-sm font-medium text-fg-1">{info?.title ?? project ?? sessionId.slice(0, 8)}</span>
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
                The run is terminated on the server. You can pick it up later from “Resume a previous session” — the transcript is kept by
                the engine, not by the gateway.
              </AlertDialogDescription>
              <div className="mt-4 flex justify-end gap-2">
                <AlertDialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button variant="destructive" onClick={() => void close()}>
                  Close session
                </Button>
              </div>
            </AlertDialogContent>
          </AlertDialog>
          {actions}
        </div>
      )}
    />
  )
}
