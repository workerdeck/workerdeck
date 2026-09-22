import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionInfo, ShellInfo } from '@workerdeck/protocol'
import type { ShellItem, TranscriptItem } from '@workerdeck/react'

export type ShellFrameOptions = {
  sessionId: string | undefined
  items: readonly TranscriptItem[]
  session: SessionInfo | undefined
  shells?: readonly ShellInfo[]
  reveal?: { toolUseId: string; nonce: number }
  openShell?: { shellId: string; nonce: number }
  onShellChange?: (shellId: string | undefined) => void
}

export type ShellFrame = {
  shellId: string | undefined
  enterShell: (shellId: string) => void
  leaveShell: () => void
  returnReveal: { toolUseId: string; nonce: number } | undefined
  shell: ShellInfo | undefined
  label: string
}

// The shell frame machine, the sub-agent frame's twin: entry keys on the nonce alone, Escape
// leaves, and the report is deduped through a ref so an echo of our own report is inert.
export function useShellFrame(options: ShellFrameOptions): ShellFrame {
  const { sessionId, items, session, shells, reveal, openShell, onShellChange } = options

  const [shellId, setShellId] = useState<string | undefined>(undefined)
  const [returnReveal, setReturnReveal] = useState<{ toolUseId: string; nonce: number } | undefined>(undefined)
  useEffect(() => {
    setShellId(undefined)
    setReturnReveal(undefined)
  }, [sessionId])

  const rowIdRef = useRef<string | undefined>(undefined)
  const row = useMemo(
    () => (shellId === undefined ? undefined : items.find((item): item is ShellItem => item.kind === 'shell' && item.shell.id === shellId)),
    [items, shellId],
  )
  rowIdRef.current = row?.id

  // Leaving reveals the `$` row the frame came from, so the reader lands where they left.
  const leaveShell = useCallback(() => {
    setShellId((current) => {
      const rowId = rowIdRef.current
      if (current !== undefined && rowId !== undefined) {
        setReturnReveal({ toolUseId: rowId, nonce: Date.now() })
      }
      return undefined
    })
  }, [])

  const openShellNonce = openShell?.nonce
  const openShellId = openShell?.shellId
  useEffect(() => {
    if (openShellId === undefined) {
      leaveShell()
    } else {
      setShellId(openShellId)
    }
    // Keyed on the nonce alone: an unchanged nonce is the host echoing our own report, and
    // acting on it starts the URL -> panel -> URL cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openShellNonce])

  const revealNonce = reveal?.nonce
  useEffect(() => {
    if (revealNonce === undefined) {
      return
    }
    setShellId(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealNonce])

  useEffect(() => {
    if (shellId === undefined) {
      return
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      leaveShell()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shellId, leaveShell])

  const onShellChangeRef = useRef(onShellChange)
  onShellChangeRef.current = onShellChange
  const reportedShellId = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (reportedShellId.current === shellId) {
      return
    }
    reportedShellId.current = shellId
    onShellChangeRef.current?.(shellId)
  }, [shellId])

  const shell = useMemo(() => {
    if (shellId === undefined) {
      return undefined
    }
    return row?.shell ?? shells?.find((record) => record.id === shellId) ?? session?.shells?.find((record) => record.id === shellId)
  }, [row, shells, session, shellId])

  const label = shell ? shell.label || shell.command.split('\n')[0] || 'shell' : 'shell'

  return { shellId, enterShell: setShellId, leaveShell, returnReveal, shell, label }
}
