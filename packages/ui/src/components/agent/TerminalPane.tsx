import { useEffect, useRef, useState } from 'react'
import type { FitAddon } from '@xterm/addon-fit'
import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import { useTerminal } from '@workerdeck/react'
import type { SessionHandle } from '@workerdeck/client'
import { cn } from '../../lib/utils.ts'
import { Spinner } from '../ui/Spinner.tsx'

export interface TerminalPaneProps {
  handle: SessionHandle | undefined
  command?: string
  onExit?: (result: { exitCode: number; signal?: number }) => void
  className?: string
}

export function TerminalPane({ handle, command, onExit, className }: TerminalPaneProps) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [ready, setReady] = useState(false)
  const opened = useRef(false)
  const theme = useDocumentTheme()

  const session = useTerminal(handle, {
    onData: (data) => term.current?.write(data),
    onExit: (result) => {
      term.current?.write(`\r\n\x1b[2m[exit ${result.exitCode}]\x1b[0m\r\n`)
      onExit?.(result)
    },
  })
  const sessionRef = useRef(session)
  sessionRef.current = session

  useEffect(() => {
    let disposed = false
    void loadXterm().then(({ Terminal, FitAddon: Fit }) => {
      if (disposed || !host.current) {
        return
      }
      const instance = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        fontSize: 12,
        lineHeight: 1.35,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        theme: xtermTheme(document.documentElement.getAttribute('data-theme')),
        scrollback: 5000,
      })
      const addon = new Fit()
      instance.loadAddon(addon)
      instance.open(host.current)
      addon.fit()
      instance.onData((data) => sessionRef.current.write(data))
      instance.onResize(({ cols, rows }) => sessionRef.current.resize({ cols, rows }))
      term.current = instance
      fit.current = addon
      setReady(true)
    })
    return () => {
      disposed = true
      opened.current = false
      sessionRef.current.close()
      term.current?.dispose()
      term.current = null
      fit.current = null
      setReady(false)
    }
  }, [])

  // The socket arrives from the panel a render *after* this mounts, so the open is driven by both
  // becoming true, never from inside the loader callback.
  useEffect(() => {
    const instance = term.current
    if (!ready || !handle || !instance || opened.current) {
      return
    }
    opened.current = true
    sessionRef.current.open({ cols: instance.cols, rows: instance.rows }, command)
  }, [ready, handle, command])

  useEffect(() => {
    const instance = term.current
    if (instance) {
      instance.options.theme = xtermTheme(theme)
    }
  }, [theme])

  useEffect(() => {
    const node = host.current
    if (!node || !ready) {
      return
    }
    const observer = new ResizeObserver(() => {
      try {
        fit.current?.fit()
      } catch {}
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ready])

  return (
    <div className={cn('relative min-h-0 overflow-hidden bg-bg', className)}>
      <div ref={host} className="h-full w-full" onClick={() => term.current?.focus()} />
      {ready ? null : (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
      {session.status === 'exited' ? (
        <button
          type="button"
          className="absolute right-2 bottom-2 rounded border border-border bg-bg-raised px-2 py-1 text-xs text-fg-muted hover:text-fg"
          onClick={() => {
            const instance = term.current
            if (!instance) {
              return
            }
            instance.clear()
            opened.current = true
            sessionRef.current.open({ cols: instance.cols, rows: instance.rows }, command)
          }}
        >
          restart
        </button>
      ) : null}
    </div>
  )
}

function useDocumentTheme(): string | null {
  const [theme, setTheme] = useState<string | null>(() =>
    typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-theme'),
  )
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setTheme(root.getAttribute('data-theme'))
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

function xtermTheme(theme: string | null): ITheme {
  return theme === 'light'
    ? { background: '#00000000', foreground: '#1f2328', cursor: '#1f2328', selectionBackground: '#b9c7d980' }
    : { background: '#00000000', foreground: '#d4d4d4', cursor: '#d4d4d4', selectionBackground: '#3a4a5f80' }
}

type XtermApi = { Terminal: typeof XTerm; FitAddon: typeof FitAddon }

let xtermPromise: Promise<XtermApi> | undefined
function loadXterm(): Promise<XtermApi> {
  xtermPromise ??= (async () => {
    const [core, fitAddon] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
    return { Terminal: core.Terminal, FitAddon: fitAddon.FitAddon }
  })()
  return xtermPromise
}
