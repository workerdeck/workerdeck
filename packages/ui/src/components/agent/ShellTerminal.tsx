import { useEffect, useRef, useState } from 'react'
import type { FitAddon } from '@xterm/addon-fit'
import type { ITheme, Terminal as XTerm } from '@xterm/xterm'
import { useShellTerminal } from '@workerdeck/react'
import type { SessionHandle } from '@workerdeck/client'
import type { ShellInfo } from '@workerdeck/protocol'
import { cn } from '../../lib/utils.ts'
import { Spinner } from '../ui/Spinner.tsx'

export interface ShellTerminalProps {
  handle: SessionHandle | undefined
  shellId: string | undefined
  onEnded?: (reason: string) => void
  onShell?: (shell: ShellInfo) => void
  fontSize?: number
  className?: string
}

export function ShellTerminal({ handle, shellId, onEnded, onShell, fontSize, className }: ShellTerminalProps) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const [ready, setReady] = useState(false)
  const attached = useRef(false)
  const theme = useDocumentTheme()
  const onShellRef = useRef(onShell)
  onShellRef.current = onShell

  const shell = useShellTerminal(handle, shellId, {
    onData: (data) => term.current?.write(data),
    onAttached: (attachment) => {
      const instance = term.current
      if (!instance) {
        return
      }
      instance.reset()
      if (attachment.scrollback) {
        instance.write(attachment.scrollback)
      }
      // Fit on attach only: a mid-stream refit reflows a cursor-addressed screen under the writer.
      try {
        fit.current?.fit()
      } catch {}
      onShellRef.current?.(attachment.shell)
    },
    onEnded: (reason) => {
      term.current?.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`)
      onEnded?.(reason)
    },
  })
  const shellRef = useRef(shell)
  shellRef.current = shell

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
        fontSize: fontSize ?? 12,
        lineHeight: 1.35,
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        theme: xtermTheme(document.documentElement.getAttribute('data-theme')),
        scrollback: 5000,
      })
      const addon = new Fit()
      instance.loadAddon(addon)
      instance.open(host.current)
      addon.fit()
      instance.onData((data) => shellRef.current.write(data))
      instance.onResize(({ cols, rows }) => shellRef.current.resize({ cols, rows }))
      term.current = instance
      fit.current = addon
      setReady(true)
    })
    return () => {
      disposed = true
      attached.current = false
      shellRef.current.detach()
      term.current?.dispose()
      term.current = null
      fit.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    attached.current = false
  }, [shellId])

  // The handle reaches this pane a render *after* it mounts, so the attach is driven by all three
  // becoming true together, never from inside the loader callback.
  useEffect(() => {
    const instance = term.current
    if (!ready || !handle || shellId === undefined || !instance || attached.current) {
      return
    }
    attached.current = true
    shellRef.current.attach({ cols: instance.cols, rows: instance.rows })
  }, [ready, handle, shellId])

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
    <div className={cn('relative min-h-0 flex-1 overflow-hidden px-2 py-1', className)}>
      <div ref={host} className="h-full w-full" onClick={() => term.current?.focus()} />
      {ready && shell.status !== 'idle' ? null : (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
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
