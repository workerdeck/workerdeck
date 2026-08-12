import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel, Toaster, type SessionControls } from '@workerdeck/ui'
import { Bridge } from './bridge.ts'

/** An absolute path, optionally `:line` — what the extension host can open.
 * One pattern for both the click and the hold-to-highlight, so nothing lights
 * up that a click would ignore. */
const PATH_PATTERN = /(\/[^\s:'"`()[\]{}]+)(?::(\d+))?/

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
}: {
  bridge: Bridge
  /** From `workerdeck.transcriptDensity`, stamped on `#root` so the first paint
   * is right — see `SessionPanelProvider.#rootAttrs`. */
  density: 'comfortable' | 'compact'
  /** From `workerdeck.transcriptVariant`, stamped alongside it. */
  variant: 'lines' | 'cards'
}) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)
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
    // Cmd/Ctrl+click on something that looks like an absolute path → ask the
    // extension host to open it (real file for loopback gateways, workerdeck://
    // for remote ones). Capture phase, so it wins over text selection.
    const onClick = (e: MouseEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const match = PATH_PATTERN.exec((e.target as HTMLElement | null)?.textContent ?? '')
      if (!match) return
      e.preventDefault()
      e.stopPropagation()
      bridge.post({
        kind: 'wd-open-path',
        path: match[1],
        line: match[2] ? Number(match[2]) : undefined,
      })
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
      const match = PATH_PATTERN.exec(text)
      // Mostly-a-path, or an element whose whole job is to be one (inline code).
      if (!match || (match[0].length < text.length * 0.6 && element.tagName !== 'CODE')) return
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
        // From `workerdeck.transcriptVariant`, defaulting to `lines`: a dock has
        // no vertical space to spend on cards, so every event is one full-width
        // line behind a gutter glyph — the terminal treatment. Someone who drags
        // the panel out into the editor area can ask for the chat form instead.
        transcriptVariant={variant}
        // From `workerdeck.transcriptDensity`. Independent of the variant: a
        // dock draws its rows as lines, and may still leave a blank line between
        // them the way the CLI does.
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
