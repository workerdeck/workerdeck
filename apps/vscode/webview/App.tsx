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
 * `panelSurface: 'external'` — no dialogs, no `⋯` menu; panel-open intents and
 * live vitals flow to the extension host, which routes them to the sidebar's
 * scoped sections. Keyed by gateway+session so switching remounts the panel —
 * the documented way to move it between sessions.
 */
export function App({
  bridge,
  density,
  variant,
  terminalMetrics,
  affordances,
}: {
  bridge: Bridge
  /** From `workerdeck.transcriptDensity`, stamped on `#root` so the first paint
   * is right — see `SessionPanelProvider.#rootAttrs`. Inert under `terminal`. */
  density: 'comfortable' | 'compact'
  /** From `workerdeck.transcriptVariant`, stamped alongside it. */
  variant: 'terminal' | 'cards'
  /** The terminal theme's character cell, resolved from `editor.fontSize` /
   * `editor.lineHeight` unless overridden. Stamped for the same reason the
   * density is: it decides every row's height. */
  terminalMetrics: TerminalMetrics
  /** From `workerdeck.terminal.affordances`. */
  affordances: boolean
}) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)
  /** The sub-agent the sessions list last asked to be shown — see
   * `wd-reveal-tool-use`. */
  const [reveal, setReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  // The panel owns the session's one attach, so it owns the only setters there
  // are. The status bar's pickers reach them through here.
  const controls = useRef<SessionControls | undefined>(undefined)
  /**
   * A focus asked for while no composer could take it yet.
   *
   * Needed because `wd-focus-composer` is its own postMessage — a separate task
   * from the `wd-show-session` before it — and switching sessions REMOUNTS the
   * panel (the key changes). React flushes the new panel's effects, and therefore
   * `onControls`, on its own schedule, which can be after this message lands. So
   * the request is recorded and retried when a composer turns up, rather than
   * fired once into whatever happens to be mounted.
   */
  const focusWanted = useRef(false)
  const tryFocus = () => {
    if (!focusWanted.current || !controls.current) return
    focusWanted.current = false
    controls.current.focusComposer()
  }

  useEffect(
    () =>
      bridge.onHostMessage((msg) => {
        if (msg.kind === 'wd-show-session') setShown(msg.session)
        else if (msg.kind === 'wd-set-model') controls.current?.setModel(msg.model)
        else if (msg.kind === 'wd-set-permission-mode') {
          controls.current?.setPermissionMode(msg.mode)
        } else if (msg.kind === 'wd-focus-composer') {
          focusWanted.current = true
          tryFocus()
        } else if (msg.kind === 'wd-reveal-tool-use') {
          // Straight to state, unlike the focus above: `reveal` is a *prop*, so
          // a request that arrives before the transcript has mounted is still
          // honoured — the panel reads it on its first render and jumps then.
          // The host's nonce rides through unchanged, since it is what makes a
          // repeat of the same id a second request rather than a no-op.
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
    // Cmd/Ctrl+click on something that looks like a path → ask the extension
    // host to open it (real file for loopback gateways, workerdeck:// for
    // remote ones; a relative path is resolved against the session cwd there,
    // which is the only side that knows it). Capture phase, so it wins over
    // text selection.
    const onClick = (e: MouseEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const match = matchPath((e.target as HTMLElement | null)?.textContent)
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      bridge.post({ kind: 'wd-open-path', path: match.path, line: match.line })
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [bridge])

  // Hold Cmd/Ctrl and the things that would open light up under the pointer —
  // the editor's own ctrl-hover affordance. Marked in JS rather than CSS because
  // "is this text a path" is not a selector; the element is only marked when the
  // path is *most* of what it says, so holding the key doesn't underline a whole
  // paragraph that happens to mention one.
  useEffect(() => {
    let hovered: HTMLElement | undefined

    const unmark = () => {
      hovered?.classList.remove(LINKISH)
      hovered = undefined
    }
    const mark = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : undefined
      if (element === hovered) return
      unmark()
      if (!element) return
      const text = element.textContent?.trim() ?? ''
      const match = matchPath(text)
      // Mostly-a-path, or an element whose whole job is to be one (inline code).
      if (!match || (match.length < text.length * 0.6 && element.tagName !== 'CODE')) return
      hovered = element
      element.classList.add(LINKISH)
    }

    const onMove = (e: MouseEvent) => {
      if (e.metaKey || e.ctrlKey) mark(e.target)
      else unmark()
    }
    // Releasing the key (or leaving the window with it down) has to clear it:
    // an underline that outlives the modifier promises a click that won't work.
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey) unmark()
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
    return (
      <div className='flex h-screen items-center justify-center text-sm text-fg-3'>
        Pick a session in the WorkerDeck sidebar.
      </div>
    )
  }

  return (
    <div className='h-screen'>
      <SessionPanel
        key={`${shown.baseUrl}#${shown.sessionId}`}
        client={client}
        sessionId={shown.sessionId}
        className='h-full'
        // From `workerdeck.transcriptVariant`, defaulting to `terminal`: this
        // panel sits beside the editor and the integrated terminal, and the CLI
        // it mirrors is what it should look like. Someone who drags the panel
        // out into the editor area can ask for the chat form instead.
        transcriptVariant={variant}
        // The cell, from the editor's own font size unless overridden — the
        // panel and the terminal below it then draw at the same size, which is
        // the whole claim.
        terminalMetrics={terminalMetrics}
        affordances={affordances}
        // The overview ruler, in the dock that most needs it: this panel is
        // narrow and tall, so a long run scrolls further here than anywhere
        // else, and VS Code's own ruler is the thing beside it that this is
        // modelled on. Inert under `cards`.
        scrubber
        // Where the sessions list's sub-agent rows land. A sub-agent has no
        // screen of its own — its work is nested inside one `Task` row of this
        // transcript — so opening one means arriving at that row.
        reveal={reveal}
        // The CLI keeps the prompt in view while the turn runs; a dock is the
        // narrowest surface we have, so it needs that most.
        stickyPrompt
        // From `workerdeck.transcriptDensity`, and `cards` only: a terminal has
        // one line height, so under `terminal` this reaches nothing.
        transcriptDensity={density}
        panelSurface='external'
        // Model and mode live in the window status bar (a click there opens a
        // QuickPick), so the composer keeps no toolbar row and collapses to a
        // single line — the vertical space a dock cannot spare.
        controlsSurface='external'
        // A dock is focussed in order to type in it: a click on anything that
        // isn't itself a control puts the caret in the composer.
        focusComposerOnClick
        // What had been seen last time this session was on screen — the panel
        // turns it into the recap row, the dimming and the catch-up bar.
        unseen={shown.unseen}
        onControls={(c) => {
          controls.current = c
          // A focus that arrived before this panel existed applies now.
          tryFocus()
        }}
        // The window status bar renders these instead (src/status-bar.ts) — a
        // second bar inside a panel that already sits in one is a bar too many.
        statusSurface='external'
        onOpenPanel={(panel) => bridge.post({ kind: 'wd-open-panel', panel })}
        onVitals={(vitals) => bridge.post({ kind: 'wd-vitals', vitals })}
      />
      <Toaster />
    </div>
  )
}
