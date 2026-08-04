import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorkerDeckClient, SessionHandle } from '@workerdeck/client'
import type { AttachedFrame, PermissionMode, SessionEvent } from '@workerdeck/protocol'
import {
  applyEvent,
  initialTranscriptState,
  seedFromSessionInfo,
  type TranscriptState,
} from './transcript.ts'

/** Session events drive the reducer; the attach snapshot seeds fields (permission
 * mode, model) that a promptless session's event stream doesn't carry yet. */
function reduce(state: TranscriptState, action: SessionEvent | AttachedFrame): TranscriptState {
  return action.type === 'attached'
    ? seedFromSessionInfo(state, action.session)
    : applyEvent(state, action)
}

export type UseClaudeSessionOptions = {
  /** Called when the server rejects a command with a protocol_error frame — e.g. a
   * permission-mode switch the CLI refuses. Without a handler these are dropped
   * silently and the UI looks like "nothing happened". */
  onProtocolError?: (message: string) => void
}

export type UseClaudeSessionResult = {
  state: TranscriptState
  connected: boolean
  /** The live attach handle, for wiring companions that must ride the SAME
   * socket — e.g. useToolCallHost: the bridge asks the first attached client,
   * so a host on a second handle would never see the requests. Undefined until
   * attached and after unmount. */
  handle: SessionHandle | undefined
  send: (text: string) => void
  approve: (requestId: string, updatedInput?: Record<string, unknown>) => void
  deny: (requestId: string, message?: string) => void
  interrupt: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
}

/** Attach to a session and maintain live transcript state. Detaches on unmount. */
export function useClaudeSession(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  options?: UseClaudeSessionOptions,
): UseClaudeSessionResult {
  const [state, dispatch] = useReducer(reduce, initialTranscriptState)
  const [connected, setConnected] = useState(false)
  // Ref for the stable callbacks below; state so consumers of `handle` re-render
  // when the socket opens or the session switches.
  const [handleState, setHandleState] = useState<SessionHandle | undefined>()
  const handleRef = useRef<SessionHandle | null>(null)
  // Ref'd so a new inline callback doesn't tear down and reopen the socket.
  const onProtocolErrorRef = useRef(options?.onProtocolError)
  onProtocolErrorRef.current = options?.onProtocolError

  useEffect(() => {
    if (!sessionId) return
    const handle = client.attach(sessionId)
    handleRef.current = handle
    setHandleState(handle)
    const offEvent = handle.on('event', (event: SessionEvent) => dispatch(event))
    const offAttached = handle.on('attached', (frame: AttachedFrame) => dispatch(frame))
    const offConn = handle.on('connectionChange', setConnected)
    const offProtocolError = handle.on('protocolError', (message: string) => {
      onProtocolErrorRef.current?.(message)
    })
    return () => {
      offEvent()
      offAttached()
      offConn()
      offProtocolError()
      handle.detach()
      handleRef.current = null
      setHandleState(undefined)
    }
  }, [client, sessionId])

  return useMemo(
    () => ({
      state,
      connected,
      handle: handleState,
      send: (text) => handleRef.current?.send(text),
      approve: (requestId, updatedInput) => handleRef.current?.approve(requestId, updatedInput),
      deny: (requestId, message) => handleRef.current?.deny(requestId, message),
      interrupt: () => handleRef.current?.interrupt(),
      setPermissionMode: (mode) => handleRef.current?.setPermissionMode(mode),
      setModel: (model) => handleRef.current?.setModel(model),
      closeSession: () => handleRef.current?.closeSession(),
    }),
    [state, connected, handleState],
  )
}
