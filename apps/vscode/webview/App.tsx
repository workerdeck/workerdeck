import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { SessionPanel, Toaster } from '@workerdeck/ui'
import { Bridge } from './bridge.ts'

type Shown = { baseUrl: string; sessionId: string; hostName: string }

/**
 * The agent panel webview: purely the conversation. `SessionPanel` runs with
 * `panelSurface: 'external'` — no dialogs, no `⋯` menu; panel-open intents and
 * live vitals flow to the extension host, which routes them to the sidebar's
 * scoped sections. Keyed by gateway+session so switching remounts the panel —
 * the documented way to move it between sessions.
 */
export function App({ bridge }: { bridge: Bridge }) {
  const [shown, setShown] = useState<Shown | undefined>(undefined)

  useEffect(
    () =>
      bridge.onHostMessage((msg) => {
        if (msg.kind === 'wd-show-session') setShown(msg.session)
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
      const text = (e.target as HTMLElement | null)?.textContent ?? ''
      const match = /(\/[^\s:'"`()[\]{}]+)(?::(\d+))?/.exec(text)
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
        panelSurface='external'
        onOpenPanel={(panel) => bridge.post({ kind: 'wd-open-panel', panel })}
        onVitals={(vitals) => bridge.post({ kind: 'wd-vitals', vitals })}
      />
      <Toaster />
    </div>
  )
}
