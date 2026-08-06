import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorkerDeckClient, SessionHandle } from '@workerdeck/client'
import { PROTOCOL_VERSION } from '@workerdeck/protocol'
import type {
  AttachedFrame,
  ModelOption,
  PermissionMode,
  SessionEvent,
} from '@workerdeck/protocol'
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

/**
 * How the client is doing at reaching the gateway — deliberately not the session's
 * status. The two are orthogonal, and while the socket is down the status a client
 * holds is *stale*, so a surface that merges them must say so rather than keep
 * claiming "idle".
 *
 * The handle retries forever, so `offline` is a judgement about how long it has
 * been failing rather than a state the transport reports.
 */
export type ConnectionState = 'live' | 'reconnecting' | 'offline'

/** Failed attempts in a row before "reconnecting…" stops being the honest word.
 * Three is ~3.5s of backoff — past a blip. Matches the iOS client. */
const OFFLINE_AFTER_ATTEMPTS = 3

export type UseClaudeSessionOptions = {
  /** Called when the server rejects a command with a protocol_error frame — e.g. a
   * permission-mode switch the CLI refuses. Without a handler these are dropped
   * silently and the UI looks like "nothing happened". */
  onProtocolError?: (message: string) => void
}

export type UseClaudeSessionResult = {
  state: TranscriptState
  /** True while the socket is open. {@link UseClaudeSessionResult.connection}
   * carries the same fact with the "has it been failing a while" distinction. */
  connected: boolean
  connection: ConnectionState
  /** The server's `PROTOCOL_VERSION` when it disagrees with the one this build
   * mirrors — undefined when they match. Some events may not render. */
  protocolMismatch?: number
  /**
   * What a model picker should offer. Two sources, and which is authoritative
   * depends on the engine: the `capabilities` event is the CLI asked what it
   * supports, so for claude it wins; codex never sends one — its models are a
   * catalog shipped with the release and served on the profile — so without the
   * fallback its picker would be permanently empty and the session unswitchable.
   */
  models: ModelOption[]
  /** The model this session answers as: the one it reported, or, before it has
   * reported anything, the default it will use. */
  effectiveModel?: string
  /** The live attach handle, for wiring companions that must ride the SAME
   * socket — e.g. useToolCallHost: the bridge asks the first attached client,
   * so a host on a second handle would never see the requests. Undefined until
   * attached and after unmount. */
  handle: SessionHandle | undefined
  /** Attachment ids come from `client.uploadAttachment`, in send order. */
  send: (text: string, attachmentIds?: string[]) => void
  approve: (requestId: string, updatedInput?: Record<string, unknown>) => void
  /** `message` is fed back to the agent, which can then try something else;
   * `interrupt` also stops the turn ("deny & stop"). */
  deny: (requestId: string, message?: string, interrupt?: boolean) => void
  interrupt: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
  /** Skip the reconnect backoff — what a tab returning to the foreground does. */
  reconnectNow: () => void
}

/** Attach to a session and maintain live transcript state. Detaches on unmount. */
export function useClaudeSession(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  options?: UseClaudeSessionOptions,
): UseClaudeSessionResult {
  const [state, dispatch] = useReducer(reduce, initialTranscriptState)
  const [connection, setConnection] = useState<ConnectionState>('reconnecting')
  const [protocolMismatch, setProtocolMismatch] = useState<number | undefined>()
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
    const offAttached = handle.on('attached', (frame: AttachedFrame) => {
      dispatch(frame)
      setProtocolMismatch(
        frame.protocolVersion === PROTOCOL_VERSION ? undefined : frame.protocolVersion,
      )
    })
    const offConn = handle.on('connectionChange', (open: boolean) =>
      setConnection(open ? 'live' : 'reconnecting'),
    )
    const offRetry = handle.on('reconnectAttempt', (attempts: number) =>
      setConnection(attempts >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting'),
    )
    const offProtocolError = handle.on('protocolError', (message: string) => {
      onProtocolErrorRef.current?.(message)
    })
    return () => {
      offEvent()
      offAttached()
      offConn()
      offRetry()
      offProtocolError()
      handle.detach()
      handleRef.current = null
      setHandleState(undefined)
      setConnection('reconnecting')
      setProtocolMismatch(undefined)
    }
  }, [client, sessionId])

  const models = useProfileModelFallback(client, sessionId, state)

  const connected = connection === 'live'
  const reconnectNow = useCallback(() => handleRef.current?.reconnectNow(), [])

  return useMemo(
    () => ({
      state,
      connected,
      connection,
      protocolMismatch,
      models,
      effectiveModel: state.model ?? state.defaultModel,
      handle: handleState,
      send: (text, attachmentIds) => handleRef.current?.send(text, attachmentIds),
      approve: (requestId, updatedInput) => handleRef.current?.approve(requestId, updatedInput),
      deny: (requestId, message, interrupt) =>
        handleRef.current?.deny(requestId, message, interrupt),
      interrupt: () => handleRef.current?.interrupt(),
      setPermissionMode: (mode) => handleRef.current?.setPermissionMode(mode),
      setModel: (model) => handleRef.current?.setModel(model),
      closeSession: () => handleRef.current?.closeSession(),
      reconnectNow,
    }),
    [state, connected, connection, protocolMismatch, models, handleState, reconnectNow],
  )
}

/**
 * The session's profile catalog, fetched once and only when it could matter —
 * i.e. when the engine has reported no models of its own.
 *
 * Fire-and-forget on purpose: an empty catalog is exactly the state a picker
 * already handles, so a failed or 404'd `/profiles` (a server predating them)
 * degrades to the old behaviour rather than raising an error about a list the
 * operator may never open.
 */
function useProfileModelFallback(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  state: TranscriptState,
): ModelOption[] {
  const [catalog, setCatalog] = useState<ModelOption[]>([])
  const profile = state.session?.profile
  const reported = state.models
  const hasReported = !!reported?.length

  useEffect(() => setCatalog([]), [sessionId])

  useEffect(() => {
    if (!profile || hasReported) return
    let cancelled = false
    client
      .listProfiles()
      .then((response) => {
        if (!cancelled) {
          setCatalog(response.profiles.find((p) => p.name === profile)?.models ?? [])
        }
      })
      .catch(() => {
        // No catalog: the picker falls back to whatever the session reports.
      })
    return () => {
      cancelled = true
    }
  }, [client, profile, hasReported])

  return hasReported ? reported : catalog
}
