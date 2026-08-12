import { useEffect, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
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
import { getTranscriptDensity, getTranscriptVariant } from '@/lib/settings.ts'
import { getRail, setRail } from '@/lib/rail.ts'
import { useMarkSeen, unseenSince } from '@/lib/useUnseen.ts'
import { nudgeSessions } from '@/lib/useSessions.ts'

/**
 * Resolves the route's gateway before anything below it runs.
 *
 * Split in two so the inner view can take a *defined* client: a session id is
 * meaningless without the gateway it belongs to, and hooks cannot be skipped
 * while we work out whether that gateway still exists (a link can outlive the
 * gateway it named — removed, or opened in a browser that never had it).
 */
export function SessionView() {
  const { hostId, sessionId } = useParams({ from: '/sessions/$hostId/$sessionId' })
  const { ready } = useHosts()
  const navigate = useNavigate()
  const client = clientFor(hostId)

  useEffect(() => {
    // Not until the same-origin probe has answered: the implicit gateway does
    // not exist yet at first paint, and bouncing off it would break every
    // bookmark on the way in.
    if (!ready || client) return
    toast.error('That gateway is not configured here')
    void navigate({ to: '/sessions' })
  }, [ready, client, navigate])

  if (!client) return null
  return <SessionViewInner key={`${hostId}:${sessionId}`} hostId={hostId} sessionId={sessionId} client={client} />
}

function SessionViewInner({
  hostId,
  sessionId,
  client,
}: {
  hostId: string
  sessionId: string
  client: WorkerDeckClient
}) {
  const navigate = useNavigate()
  // The workspace asks for this record too, and the client de-dupes nothing —
  // but it is one small GET per session view, and the alternative is threading
  // the panel's session state back out through a prop nobody else wants.
  const { info, error } = useSessionInfo(client, sessionId)
  const markSeen = useMarkSeen(hostId, sessionId)
  // Read ONCE per session, on mount: the catch-up row marks where reading left
  // off last time, and re-reading it as the mark moves would walk the row down
  // the transcript under the reader.
  const [unseen] = useState(() => unseenSince(hostId, sessionId))
  const [density] = useState(getTranscriptDensity)
  const [variant] = useState(getTranscriptVariant)
  // Read once: the workspace owns the live value from here, and re-seeding it
  // mid-session would yank the splitter out from under a drag.
  const [rail] = useState(getRail)

  useEffect(() => {
    if (!error) return
    toast.error('Session not found')
    void navigate({ to: '/sessions' })
  }, [error, navigate])

  const close = async () => {
    try {
      await client.deleteSession(sessionId)
    } catch {
      // already gone
    }
    void navigate({ to: '/sessions' })
  }

  // The project name, like the iOS app's navigation title — the full path is a
  // line of monospace nobody reads, and it is one tap away in Session info.
  const project = info?.cwd?.split('/').filter(Boolean).pop()

  return (
    <SessionWorkspace
      key={sessionId}
      client={client}
      sessionId={sessionId}
      transcriptVariant={variant}
      transcriptDensity={density}
      // Along the foot of the editor area, as an editor puts it.
      statusPlacement='bottom'
      defaultRailWidth={rail.width}
      defaultRailCollapsed={rail.collapsed}
      onRailChange={setRail}
      unseen={unseen}
      // This route IS the session on screen, so its readings are what "read up
      // to here" means. `useMarkSeen` still refuses while the tab is hidden.
      onVitals={(vitals) => {
        markSeen({ itemCount: vitals.itemCount, activity: info?.activityCount, turns: info?.numTurns })
        // This socket knows a turn started before any poll could. Coalesced and
        // rate-limited inside, so calling it per streamed delta is fine.
        nudgeSessions()
      }}
      // A function, so the panel hands over its `⋯` menu instead of leaving it
      // on the status bar: this app has a real top bar, and the session's
      // controls belong together there rather than split across two rows.
      header={({ actions }) => (
        <div className='flex items-center gap-2 border-b border-border bg-surface px-3 py-2'>
          {/* No back button: the sessions sidebar is always on screen, so there
              is nothing to go back *to*. */}
          <span className='truncate text-body-sm font-medium text-fg-1'>
            {info?.title ?? project ?? sessionId.slice(0, 8)}
          </span>
          {/* Which engine is answering — the one session-level fact that changes
              what every other control means. */}
          {info?.engine && info.engine !== 'claude' ? (
            <Badge variant='neutral' className='shrink-0'>
              {info.engine}
            </Badge>
          ) : null}
          {info?.cwd ? (
            <span className='min-w-0 truncate font-mono text-label text-fg-4' title={info.cwd}>
              {info.cwd}
            </span>
          ) : null}
          <span className='flex-1' />
          <CopyButton value={sessionId} aria-label='Copy session id' />
          <AlertDialog>
            <AlertDialogTrigger
              render={
                <Button variant='ghost' size='icon-sm' aria-label='Close session'>
                  <Trash2 className='size-4 text-fg-3' />
                </Button>
              }
            />
            <AlertDialogContent>
              <AlertDialogTitle>Close this session?</AlertDialogTitle>
              <AlertDialogDescription>
                The run is terminated on the server. You can pick it up later from “Resume a
                previous session” — the transcript is kept by the engine, not by the gateway.
              </AlertDialogDescription>
              <div className='mt-4 flex justify-end gap-2'>
                <AlertDialogClose render={<Button variant='outline'>Cancel</Button>} />
                <Button variant='destructive' onClick={() => void close()}>
                  Close session
                </Button>
              </div>
            </AlertDialogContent>
          </AlertDialog>
          {/* Last, to the right of Close session — the panel builds it (it needs
              the capability record and the host-file verdict) and we place it. */}
          {actions}
        </div>
      )}
    />
  )
}
