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
import { getTranscriptDensity, getTranscriptFont, getTranscriptVariant } from '@/lib/settings.ts'
import { getRail, setRail } from '@/lib/rail.ts'
import { useMarkSeen, unseenSince } from '@/hooks/useUnseen.ts'
import { nudgeSessions, useSessions } from '@/hooks/useSessions.ts'

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
  // The sub-agent takeover, addressed in the URL — see the route's
  // `validateSearch`. `sn` is the nonce; without one, clicking the same agent
  // twice would be a props-equal no-op.
  const { subagent, sn, reveal, rn } = useSearch({ from: '/sessions/$hostId/$sessionId' })
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
  const [font] = useState(getTranscriptFont)
  // Read once: the workspace owns the live value from here, and re-seeding it
  // mid-session would yank the splitter out from under a drag.
  const [rail] = useState(getRail)

  useEffect(() => {
    if (!error) return
    toast.error('Session not found')
    void navigate({ to: '/sessions' })
  }, [error, navigate])

  // Whether this tab is actually being looked at, as **state** rather than a
  // read of `document.hidden`. It is a dependency of "is this on screen": while
  // the tab is hidden every mark is refused, so without something re-running on
  // the way back, a session you left mid-turn keeps its badge after you return
  // and look straight at it.
  const [visible, setVisible] = useState(() => !document.hidden)
  useEffect(() => {
    const sync = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // Mark off the SAME record the badge counts from — the polled sessions list.
  //
  // The badge is `unseenFor(hostId, info)` over `useSessions`' snapshots, which
  // poll every 1.2s while anything is working. Two near-misses are worth naming,
  // because both look right and neither is:
  //
  //  - Marking inside `onVitals` alone. Those fire per streamed delta and stop
  //    with the last token, but the row that *ends* a turn reaches the registry
  //    after them — so the session you sat and watched kept a badge for the rows
  //    it finished with.
  //  - Marking off `useSessionInfo`. It is one GET at mount and is never polled,
  //    so its `activityCount` is frozen; an effect on it fires once and then
  //    never again, which looks like a fix for exactly one render.
  //
  // Reading the same poll the badge reads closes the loop by construction:
  // anything the badge can count, this has already seen. `useMarkSeen` still
  // refuses while the tab is hidden, and `Watermarks.mark` is monotonic per
  // field, so a partial reading can never walk `itemCount` back.
  const { snapshots } = useSessions()
  const polled = useMemo(
    () =>
      snapshots
        .find((s) => s.host.id === hostId)
        ?.sessions.find((s) => s.id === sessionId),
    [snapshots, hostId, sessionId],
  )
  useEffect(() => {
    if (!polled || !visible) return
    markSeen({ activity: polled.activityCount, turns: polled.numTurns })
  }, [polled?.activityCount, polled?.numTurns, visible, markSeen])

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
      transcriptFont={font}
      openSubagent={subagent ? { toolUseId: subagent, nonce: sn ?? 0 } : undefined}
      // Travel to a row without framing anything — where a **task** press
      // lands. Its own nonce, so asking for the same row twice scrolls twice;
      // and `reveal` beats a standing frame inside the panel (latest intent
      // wins), which is exactly right here: the press said "show me where this
      // happened", and a frame left up over it would be showing something else.
      reveal={reveal ? { toolUseId: reveal, nonce: rn ?? 0 } : undefined}
      // The panel's report of what it has framed, folded back into the same
      // search param the request travels in — the URL stays the one truth about
      // what is on screen (the sidebar's secondary selection reads it, a copied
      // link reproduces it, and Back/Forward drive the frame through the
      // withdrawal semantics of `openSubagent`). Three rules keep the
      // round-trip from becoming a loop:
      //
      //  - **No-op on match.** The commonest report is the echo of our own
      //    request — the panel consuming the `?subagent=` we just navigated
      //    with — and navigating again for it would start the URL → panel →
      //    URL cycle with nothing to say.
      //  - **`sn` rides through unchanged** when the panel entered a frame the
      //    URL didn't ask for (a Task row pressed in the transcript). The
      //    panel's request effect keys on the nonce, so an unchanged one makes
      //    our write inert on arrival; a fresh nonce here would re-request the
      //    very frame we are merely describing, and a fresh one per report is
      //    the loop.
      //  - **`replace`, never push.** A report is bookkeeping about state
      //    already on screen, not travel: pushes stay reserved for deliberate
      //    navigations (the sidebar's clicks), so Escape doesn't mint a
      //    history entry per press and Back undoes navigations, not
      //    keystrokes. The one Back-visible consequence: a frame entered from
      //    inside the transcript leaves no entry of its own, so Back from it
      //    exits the page rather than the frame — the strip's Back and Escape
      //    are the frame's own way out.
      onSubagentChange={(toolUseId) => {
        if (toolUseId === subagent) return
        void navigate({
          to: '/sessions/$hostId/$sessionId',
          params: { hostId, sessionId },
          search: toolUseId === undefined ? {} : (prev) => ({ subagent: toolUseId, sn: prev.sn }),
          replace: true,
        })
      }}
      // The overview ruler, when the transcript is the terminal one — a session
      // that ran for an hour is a long scroll, and the rail is the only thing
      // that says where in it the answers are. Inert under `cards`.
      scrubber
      // And the prompt you are waiting on, held above the answer.
      stickyPrompt
      // Along the foot of the editor area, as an editor puts it.
      statusPlacement='bottom'
      // Model and mode ride that bar too, beside the readings they act on —
      // the VS Code arrangement, and it buys the composer its second row back.
      controlsSurface='status'
      defaultRailWidth={rail.width}
      defaultRailCollapsed={rail.collapsed}
      onRailChange={setRail}
      unseen={unseen}
      // This route IS the session on screen, so its readings are what "read up
      // to here" means. `useMarkSeen` still refuses while the tab is hidden.
      onVitals={(vitals) => {
        // Only `itemCount` — the socket is the sole source of it, and it is what
        // the catch-up row reads. `activity`/`turns` ride the effect above, off
        // the record the badge itself counts from; passing the closure's `info`
        // here wrote whatever the last render happened to hold.
        markSeen({ itemCount: vitals.itemCount })
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
