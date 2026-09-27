import { useMemo, useRef } from 'react'
import type { SessionInfo, ShellInfo } from '@workerdeck/protocol'
import type { ShellItem, TranscriptItem } from '@workerdeck/react'
import { useFrame } from './use-frame.ts'

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

export function useShellFrame(options: ShellFrameOptions): ShellFrame {
  const { sessionId, items, session, shells, reveal, openShell, onShellChange } = options
  const rowIdRef = useRef<string | undefined>(undefined)
  const frame = useFrame({
    sessionId,
    request: openShell && { id: openShell.shellId, nonce: openShell.nonce },
    reveal,
    onChange: onShellChange,
    returnTo: () => rowIdRef.current,
  })
  const shellId = frame.id

  const row = useMemo(
    () => (shellId === undefined ? undefined : items.find((item): item is ShellItem => item.kind === 'shell' && item.shell.id === shellId)),
    [items, shellId],
  )
  rowIdRef.current = row?.id

  const shell = useMemo(() => {
    if (shellId === undefined) {
      return undefined
    }
    return row?.shell ?? shells?.find((record) => record.id === shellId) ?? session?.shells?.find((record) => record.id === shellId)
  }, [row, shells, session, shellId])

  const label = shell ? shell.label || shell.command.split('\n')[0] || 'shell' : 'shell'

  return { shellId, enterShell: frame.enter, leaveShell: frame.leave, returnReveal: frame.returnReveal, shell, label }
}
