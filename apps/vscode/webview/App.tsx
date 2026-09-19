import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel, Toaster, usePathLinks, type PathHit, type SessionControls, type TerminalMetrics } from '@workerdeck/ui'
import type { Bridge } from './bridge.ts'


type Shown = {
  baseUrl: string
  sessionId: string
  hostName: string
  unseen?: { itemCount: number; since: number }
}

// Same contract as the dashboard's useBookmarks: item ids per session, persisted client-side.
// The webview's localStorage is per-extension-origin and survives reloads; losing it costs
// starred rows only, so every access swallows (webviews can run with storage denied).
const BOOKMARKS_KEY = 'workerdeck.bookmarks.v1'

function useBookmarks(sessionKey: string) {
  const [map, setMap] = useState<Record<string, string[]>>(() => {
    try {
      return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? '{}') as Record<string, string[]>
    } catch {
      return {}
    }
  })
  const bookmarks = map[sessionKey] ?? []
  const toggle = useCallback(
    (itemId: string) => {
      setMap((previous) => {
        const current = previous[sessionKey] ?? []
        const next = current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]
        const merged = { ...previous, [sessionKey]: next }
        if (next.length === 0) {
          delete merged[sessionKey]
        }
        try {
          localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(merged))
        } catch {}
        return merged
      })
    },
    [sessionKey],
  )
  return { bookmarks, toggle }
}

export function App({
  bridge,
  density,
  variant,
  catchUp,
  terminalMetrics,
  affordances,
  fontSize,
}: {
  bridge: Bridge
  density: 'comfortable' | 'compact'
  variant: 'terminal' | 'cards'
  catchUp: boolean
  terminalMetrics: TerminalMetrics
  affordances: boolean
  fontSize?: number
}) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)
  const [openSubagent, setOpenSubagent] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  const [reveal, setReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  const controls = useRef<SessionControls | undefined>(undefined)
  // Switching sessions remounts the panel and React flushes the new `onControls` on its own schedule, which can be
  // after a `wd-focus-composer` lands - so the request is recorded and retried rather than fired at whatever is mounted.
  const focusWanted = useRef(false)
  const tryFocus = () => {
    if (!focusWanted.current || !controls.current) {
      return
    }
    focusWanted.current = false
    controls.current.focusComposer()
  }

  useEffect(
    () =>
      bridge.onHostMessage((msg) => {
        if (msg.kind === 'wd-show-session') {
          setShown(msg.session)
          setOpenSubagent(undefined)
          setReveal(undefined)
        } else if (msg.kind === 'wd-set-model') {
          controls.current?.setModel(msg.model)
        } else if (msg.kind === 'wd-set-permission-mode') {
          controls.current?.setPermissionMode(msg.mode)
        } else if (msg.kind === 'wd-insert-composer-text') {
          controls.current?.insertComposerText(msg.text)
        } else if (msg.kind === 'wd-focus-composer') {
          focusWanted.current = true
          tryFocus()
        } else if (msg.kind === 'wd-open-subagent') {
          // Straight to state, unlike the focus above: `openSubagent` is a prop, so a request arriving
          // before the transcript mounted is still read on first render.
          setOpenSubagent({ toolUseId: msg.toolUseId, nonce: msg.nonce })
        } else if (msg.kind === 'wd-reveal-tool-use') {
          setReveal({ toolUseId: msg.toolUseId, nonce: msg.nonce })
        }
      }),
    [bridge],
  )

  const client = useMemo(
    () =>
      shown
        ? new WorkerDeckClient({
            baseUrl: shown.baseUrl,
            fetchImpl: bridge.fetch,
            WebSocketImpl: bridge.WebSocketImpl,
          })
        : undefined,
    [bridge, shown?.baseUrl],
  )

  const page = useRef<HTMLDivElement>(null)
  const openPath = useCallback((hit: PathHit) => bridge.post({ kind: 'wd-open-path', path: hit.path, line: hit.line }), [bridge])
  usePathLinks({ container: page, onOpen: openPath, enabled: shown !== undefined && client !== undefined })

  // Called unconditionally (hooks rule) - the empty key never accumulates entries because toggle
  // is only reachable from a mounted panel.
  const { bookmarks, toggle: toggleBookmark } = useBookmarks(shown ? `${shown.baseUrl}#${shown.sessionId}` : '')

  if (!shown || !client) {
    return <div className="flex h-screen items-center justify-center text-sm text-fg-3">Pick a session in the WorkerDeck sidebar.</div>
  }

  return (
    <div ref={page} className="h-screen">
      <SessionPanel
        key={`${shown.baseUrl}#${shown.sessionId}`}
        client={client}
        sessionId={shown.sessionId}
        className="h-full"
        transcriptVariant={variant}
        terminalMetrics={terminalMetrics}
        affordances={affordances}
        fontSize={fontSize}
        scrubber
        bookmarks={bookmarks}
        onToggleBookmark={toggleBookmark}
        onOpenFile={(path, line) => bridge.post({ kind: 'wd-open-path', path, line })}
        openSubagent={openSubagent}
        reveal={reveal}
        stickyPrompt
        transcriptDensity={density}
        panelSurface="external"
        controlsSurface="external"
        focusComposerOnClick
        unseen={catchUp ? shown.unseen : undefined}
        onControls={(c) => {
          controls.current = c
          tryFocus()
        }}
        statusSurface="external"
        onOpenPanel={(panel) => bridge.post({ kind: 'wd-open-panel', panel })}
        onVitals={(vitals) => bridge.post({ kind: 'wd-vitals', vitals })}
        onSubagentChange={(toolUseId) => bridge.post({ kind: 'wd-subagent-open', toolUseId })}
      />
      <Toaster />
    </div>
  )
}
