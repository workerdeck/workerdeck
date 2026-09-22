import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionHandle } from '@workerdeck/client'
import type { ShellInfo } from '@workerdeck/protocol'

export type ShellTerminalSize = { cols: number; rows: number }

export type ShellTerminalStatus = 'idle' | 'attaching' | 'attached' | 'detached'

export type ShellAttachment = {
  shell: ShellInfo
  cols: number
  rows: number
  scrollback: string
}

export type UseShellTerminalOptions = {
  onData: (data: string) => void
  onEnded?: (reason: string) => void
  onAttached?: (attachment: ShellAttachment) => void
}

export type UseShellTerminalResult = {
  status: ShellTerminalStatus
  shell: ShellInfo | undefined
  reason: string | undefined
  attach: (size: ShellTerminalSize) => void
  write: (data: string) => void
  resize: (size: ShellTerminalSize) => void
  detach: () => void
}

// PTY bytes never enter React state, the transcript reducer or the transcript cache: they go
// straight to the caller's renderer through a ref, so a noisy `npm run dev` re-renders nothing.
export function useShellTerminal(
  handle: SessionHandle | undefined,
  shellId: string | undefined,
  options: UseShellTerminalOptions,
): UseShellTerminalResult {
  const [status, setStatus] = useState<ShellTerminalStatus>('idle')
  const [shell, setShell] = useState<ShellInfo | undefined>(undefined)
  const [reason, setReason] = useState<string | undefined>(undefined)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const sizeRef = useRef<ShellTerminalSize>({ cols: 80, rows: 24 })
  const wantAttachRef = useRef(false)

  useEffect(() => {
    wantAttachRef.current = false
    setStatus('idle')
    setShell(undefined)
    setReason(undefined)
  }, [handle, shellId])

  useEffect(() => {
    if (!handle || shellId === undefined) {
      return
    }
    const offAttached = handle.on('shellAttached', (frame) => {
      if (frame.shellId !== shellId) {
        return
      }
      sizeRef.current = { cols: frame.cols, rows: frame.rows }
      setShell(frame.shell)
      setReason(undefined)
      setStatus('attached')
      const attachment: ShellAttachment = { shell: frame.shell, cols: frame.cols, rows: frame.rows, scrollback: frame.scrollback }
      if (optionsRef.current.onAttached) {
        optionsRef.current.onAttached(attachment)
      } else if (frame.scrollback) {
        optionsRef.current.onData(frame.scrollback)
      }
    })
    const offOutput = handle.on('shellOutput', (frame) => {
      if (frame.shellId === shellId) {
        optionsRef.current.onData(frame.data)
      }
    })
    const offDetached = handle.on('shellDetached', (frame) => {
      if (frame.shellId !== shellId) {
        return
      }
      wantAttachRef.current = false
      setReason(frame.reason)
      setStatus('detached')
      optionsRef.current.onEnded?.(frame.reason)
    })
    // A shell outlives the socket, so a reconnect re-attaches and the gateway replays the
    // scrollback into a reset screen rather than leaving a live pane frozen.
    const offConnection = handle.on('connectionChange', (connected) => {
      if (!wantAttachRef.current) {
        return
      }
      if (connected) {
        setStatus('attaching')
        handle.attachShell(shellId, sizeRef.current)
      } else {
        setStatus((current) => (current === 'attached' ? 'attaching' : current))
      }
    })
    return () => {
      offAttached()
      offOutput()
      offDetached()
      offConnection()
      if (wantAttachRef.current) {
        wantAttachRef.current = false
        handle.detachShell(shellId)
      }
    }
  }, [handle, shellId])

  const attach = useCallback(
    (size: ShellTerminalSize) => {
      if (!handle || shellId === undefined) {
        return
      }
      sizeRef.current = size
      wantAttachRef.current = true
      setReason(undefined)
      setStatus('attaching')
      handle.attachShell(shellId, size)
    },
    [handle, shellId],
  )

  const write = useCallback(
    (data: string) => {
      if (handle && shellId !== undefined) {
        handle.writeShell(shellId, data)
      }
    },
    [handle, shellId],
  )

  const resize = useCallback(
    (size: ShellTerminalSize) => {
      if (size.cols === sizeRef.current.cols && size.rows === sizeRef.current.rows) {
        return
      }
      sizeRef.current = size
      if (handle && shellId !== undefined && wantAttachRef.current) {
        handle.resizeShell(shellId, size)
      }
    },
    [handle, shellId],
  )

  const detach = useCallback(() => {
    if (handle && shellId !== undefined && wantAttachRef.current) {
      handle.detachShell(shellId)
    }
    wantAttachRef.current = false
    setStatus('idle')
  }, [handle, shellId])

  return useMemo(() => ({ status, shell, reason, attach, write, resize, detach }), [status, shell, reason, attach, write, resize, detach])
}
