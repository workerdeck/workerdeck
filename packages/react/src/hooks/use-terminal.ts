import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionHandle } from '@workerdeck/client'

export type TerminalSize = { cols: number; rows: number }

export type TerminalStatus = 'closed' | 'opening' | 'open' | 'exited'

export type UseTerminalOptions = {
  onData: (data: string) => void
  onExit?: (result: { exitCode: number; signal?: number }) => void
}

export type UseTerminalResult = {
  status: TerminalStatus
  exit: { exitCode: number; signal?: number } | undefined
  open: (size: TerminalSize, command?: string) => void
  write: (data: string) => void
  resize: (size: TerminalSize) => void
  close: () => void
}

// PTY bytes never enter React state: they go straight to the caller's renderer through a ref, so a
// noisy command re-renders nothing. Only the four-state status is state.
export function useTerminal(handle: SessionHandle | undefined, options: UseTerminalOptions): UseTerminalResult {
  const [status, setStatus] = useState<TerminalStatus>('closed')
  const [exit, setExit] = useState<{ exitCode: number; signal?: number } | undefined>()
  const optionsRef = useRef(options)
  optionsRef.current = options
  const sizeRef = useRef<TerminalSize>({ cols: 80, rows: 24 })

  useEffect(() => {
    if (!handle) {
      setStatus('closed')
      return
    }
    const offOpened = handle.on('terminalOpened', () => setStatus('open'))
    const offData = handle.on('terminalOutput', (data) => optionsRef.current.onData(data))
    const offExit = handle.on('terminalExit', (result) => {
      setStatus('exited')
      setExit(result)
      optionsRef.current.onExit?.(result)
    })
    // The PTY is bound to the socket, so a drop kills it on the gateway. Say so rather than
    // leaving a dead terminal looking live.
    const offConnection = handle.on('connectionChange', (connected) => {
      if (!connected) {
        setStatus((current) => (current === 'closed' ? current : 'exited'))
      }
    })
    return () => {
      offOpened()
      offData()
      offExit()
      offConnection()
    }
  }, [handle])

  const open = useCallback(
    (size: TerminalSize, command?: string) => {
      if (!handle) {
        return
      }
      sizeRef.current = size
      setExit(undefined)
      setStatus('opening')
      handle.openTerminal(size, command)
    },
    [handle],
  )

  const write = useCallback((data: string) => handle?.sendTerminalInput(data), [handle])

  const resize = useCallback(
    (size: TerminalSize) => {
      if (size.cols === sizeRef.current.cols && size.rows === sizeRef.current.rows) {
        return
      }
      sizeRef.current = size
      handle?.resizeTerminal(size)
    },
    [handle],
  )

  const close = useCallback(() => {
    handle?.closeTerminal()
    setStatus('closed')
  }, [handle])

  return useMemo(() => ({ status, exit, open, write, resize, close }), [status, exit, open, write, resize, close])
}
