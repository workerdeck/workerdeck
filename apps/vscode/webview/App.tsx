import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel, Toaster, type SessionControls, type TerminalMetrics } from '@workerdeck/ui'
import { Bridge } from './bridge.ts'
import { matchPath } from './paths.ts'

/** Marks the element under the pointer while Cmd/Ctrl is held (styles.css). */
const LINKISH = 'wd-linkish'

type Shown = {
  baseUrl: string
  sessionId: string
  hostName: string
  unseen?: { itemCount: number; since: number }
}

/**
 * The agent panel webview: purely the conversation. `SessionPanel` runs with
 * `panelSurface: 'external'`, so panel-open intents and live vitals flow to the
 * extension host, which routes them to the sidebar's scoped sections. Keyed by
 * gateway+session, switching remounting the panel being the documented way to move
 * it between sessions.
 */
export function App({
  bridge,
  density,
  variant,
  terminalMetrics,
  affordances,
  fontSize,
}: {
  bridge: Bridge
  /** From `workerdeck.transcriptDensity`, stamped on `#root` so the first paint is
   * right — see `SessionPanelProvider.#rootAttrs`. Inert under `terminal`. */
  density: 'comfortable' | 'compact'
  /** From `workerdeck.transcriptVariant`, stamped alongside it. */
  variant: 'terminal' | 'cards'
  /** The terminal theme's character cell, resolved from `editor.fontSize` /
   * `editor.lineHeight` unless overridden. */
  terminalMetrics: TerminalMetrics
  /** From `workerdeck.terminal.affordances`. */
  affordances: boolean
  /** From `workerdeck.fontSize`, resolved against `editor.fontSize`. Drives the
   * panel-wide scale for both variants. */
  fontSize?: number
}) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)
  /** The sub-agent the sessions list last asked to be shown — see
   * `wd-open-subagent`. */
  const [openSubagent, setOpenSubagent] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  /** The row the sessions list last asked to be travelled to — a **task**, which
   * has no agent to frame. See `wd-reveal-tool-use`. */
  const [reveal, setReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  // The panel owns the session's one attach, so it owns the only setters there are.
  const controls = useRef<SessionControls | undefined>(undefined)
  /**
   * A focus asked for while no composer could take it yet. `wd-focus-composer` is its
   * own postMessage, and switching sessions remounts the panel — React flushes the
   * new panel's `onControls` on its own schedule, which can be after this lands. So
   * the request is recorded and retried rather than fired into whatever is mounted.
   */
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
          // Clear the takeover with the session: a request left standing across a switch
          // would frame one session's Task id against another's items.
          setOpenSubagent(undefined)
          setReveal(undefined)
        } else if (msg.kind === 'wd-set-model') {
          controls.current?.setModel(msg.model)
        } else if (msg.kind === 'wd-set-permission-mode') {
          controls.current?.setPermissionMode(msg.mode)
        } else if (msg.kind === 'wd-focus-composer') {
          focusWanted.current = true
          tryFocus()
        } else if (msg.kind === 'wd-open-subagent') {
          // Straight to state, unlike the focus above: `openSubagent` is a *prop*, so a
          // request arriving before the transcript mounted is still read on first render.
          // The host's nonce rides through unchanged — it is what makes a repeat a request.
          setOpenSubagent({ toolUseId: msg.toolUseId, nonce: msg.nonce })
        } else if (msg.kind === 'wd-reveal-tool-use') {
          // Same shape as `wd-open-subagent`, other destination: a *task* has no agent
          // behind it, so it is a row to travel to rather than work to frame.
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

  useEffect(() => {
    // Capture phase, so it wins over text selection.
    const onClick = (e: MouseEvent) => {
      if (!e.metaKey && !e.ctrlKey) {
        return
      }
      const match = matchPath((e.target as HTMLElement | null)?.textContent)
      if (!match) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      bridge.post({ kind: 'wd-open-path', path: match.path, line: match.line })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [bridge])

  // Hold Cmd/Ctrl and what would open lights up — the editor's own ctrl-hover
  // affordance. In JS rather than CSS because "is this text a path" is not a selector.
  useEffect(() => {
    let hovered: HTMLElement | undefined

    const unmark = () => {
      hovered?.classList.remove(LINKISH)
      hovered = undefined
    }
    const mark = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : undefined
      if (element === hovered) {
        return
      }
      unmark()
      if (!element) {
        return
      }
      const text = element.textContent?.trim() ?? ''
      const match = matchPath(text)
      // Mostly-a-path, or an element whose whole job is to be one (inline code).
      if (!match || (match.length < text.length * 0.6 && element.tagName !== 'CODE')) {
        return
      }
      hovered = element
      element.classList.add(LINKISH)
    }

    const onMove = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) {
        mark(e.target)
      } else {
        unmark()
      }
    }
    // An underline that outlives the modifier promises a click that will not work.
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) {
        unmark()
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('keydown', onKey)
    document.addEventListener('keyup', onKey)
    window.addEventListener('blur', unmark)
    return () => {
      unmark()
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', unmark)
    }
  }, [])

  if (!shown || !client) {
    return <div className="flex h-screen items-center justify-center text-sm text-fg-3">Pick a session in the WorkerDeck sidebar.</div>
  }

  return (
    <div className="h-screen">
      <SessionPanel
        key={`${shown.baseUrl}#${shown.sessionId}`}
        client={client}
        sessionId={shown.sessionId}
        className="h-full"
        transcriptVariant={variant}
        // The cell, from the editor's own font size unless overridden, so the panel and
        // the terminal below it draw at the same size.
        terminalMetrics={terminalMetrics}
        affordances={affordances}
        fontSize={fontSize}
        // The overview ruler: this dock is narrow and tall, so a long run scrolls further
        // here than anywhere else. Inert under `cards`.
        scrubber
        openSubagent={openSubagent}
        reveal={reveal}
        stickyPrompt
        // `cards` only: a terminal has one line height, so under `terminal` this reaches nothing.
        transcriptDensity={density}
        panelSurface="external"
        // Model and mode live in the window status bar, so the composer keeps no toolbar
        // row and collapses to a single line.
        controlsSurface="external"
        // A dock is focussed in order to type in it.
        focusComposerOnClick
        // What had been seen last time this session was on screen — the panel turns it
        // into the recap row, the dimming and the catch-up bar.
        unseen={shown.unseen}
        onControls={(c) => {
          controls.current = c
          // A focus that arrived before this panel existed applies now.
          tryFocus()
        }}
        // The window status bar renders these instead (src/status-bar.ts).
        statusSurface="external"
        onOpenPanel={(panel) => bridge.post({ kind: 'wd-open-panel', panel })}
        onVitals={(vitals) => bridge.post({ kind: 'wd-vitals', vitals })}
        /* What the panel now has framed, so the sessions list can draw it as a secondary
           selection. A *statement*, not an acknowledgement — the panel enters and leaves
           frames the host never asked about — and nonce-free, a state arriving twice
           being the same state. */
        onSubagentChange={(toolUseId) => bridge.post({ kind: 'wd-subagent-open', toolUseId })}
      />
      <Toaster />
    </div>
  )
}
