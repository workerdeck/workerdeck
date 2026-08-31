import { useEffect, useMemo, useRef, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel, Toaster, type SessionControls, type TerminalMetrics } from '@workerdeck/ui'
import type { Bridge } from './bridge.ts'
import { matchPath } from './paths.ts'

const LINKISH = 'wd-linkish'

type Shown = {
  baseUrl: string
  sessionId: string
  hostName: string
  unseen?: { itemCount: number; since: number }
}

export function App({
  bridge,
  density,
  variant,
  terminalMetrics,
  affordances,
  fontSize,
}: {
  bridge: Bridge
  density: 'comfortable' | 'compact'
  variant: 'terminal' | 'cards'
  terminalMetrics: TerminalMetrics
  affordances: boolean
  fontSize?: number
}) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)
  const [openSubagent, setOpenSubagent] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  const [reveal, setReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  const controls = useRef<SessionControls | undefined>(undefined)
  // Switching sessions remounts the panel and React flushes the new `onControls` on its own schedule, which can be
  // after a `wd-focus-composer` lands — so the request is recorded and retried rather than fired at whatever is mounted.
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

  // The editor's own ctrl-hover affordance, in JS rather than CSS because "is this text a path" is not a selector.
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
        terminalMetrics={terminalMetrics}
        affordances={affordances}
        fontSize={fontSize}
        scrubber
        openSubagent={openSubagent}
        reveal={reveal}
        stickyPrompt
        transcriptDensity={density}
        panelSurface="external"
        controlsSurface="external"
        focusComposerOnClick
        unseen={shown.unseen}
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
