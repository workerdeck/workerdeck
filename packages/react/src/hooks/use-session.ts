import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorkerDeckClient, SessionHandle } from '@workerdeck/client'
import { PROTOCOL_VERSION } from '@workerdeck/protocol'
import type { AttachedFrame, ModelOption, PermissionMode, SessionEvent } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, hydrateToolResult, seedFromSessionInfo, type TranscriptState } from '../lib/transcript.ts'
import { deleteTranscriptCache, readTranscriptCache, transcriptCacheKey, writeTranscriptCache } from '../lib/transcript-cache.ts'
import { attachSeedToken, planAttach, shouldWriteParting } from '../lib/attach-plan.ts'

type SeedAction = { type: 'transcript_seed'; state: TranscriptState }
type HydrateAction = { type: 'transcript_hydrate_result'; toolUseId: string; text: string }

const reduce = (state: TranscriptState, action: SessionEvent | AttachedFrame | SeedAction | HydrateAction): TranscriptState => {
  if (action.type === 'transcript_seed') {
    return action.state
  }
  if (action.type === 'transcript_hydrate_result') {
    return hydrateToolResult(state, action.toolUseId, action.text)
  }
  return action.type === 'attached' ? seedFromSessionInfo(state, action.session) : applyEvent(state, action)
}

export type ConnectionState = 'live' | 'reconnecting' | 'offline'

// Three failed attempts is ~3.5s of backoff — past a blip; the iOS client hardcodes the same threshold.
const OFFLINE_AFTER_ATTEMPTS = 3

export const initialReplayTarget = (frame: AttachedFrame): number | undefined =>
  frame.replayingFrom === 0 && frame.session.lastSeq > 0 ? frame.session.lastSeq : undefined

export const staleAttach = (frame: AttachedFrame, held: TranscriptState): boolean => {
  if (frame.replayingFrom === 0 || held.lastSeq === 0) {
    return false
  }
  if (frame.session.lastSeq < held.lastSeq) {
    return true
  }
  return held.session !== undefined && frame.session.createdAt !== held.session.createdAt
}

export const REPLAY_HOLD_MAX_MS = 1500

export type UseClaudeSessionOptions = {
  onProtocolError?: (message: string) => void
  cacheTranscript?: boolean
}

export type UseClaudeSessionResult = {
  state: TranscriptState
  connected: boolean
  connection: ConnectionState
  replaying: boolean
  protocolMismatch?: number
  models: ModelOption[]
  effectiveModel?: string
  handle: SessionHandle | undefined
  send: (text: string, attachmentIds?: string[]) => void
  approve: (requestId: string, updatedInput?: Record<string, unknown>) => void
  deny: (requestId: string, message?: string, interrupt?: boolean) => void
  interrupt: () => void
  clearContext: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
  reconnectNow: () => void
  loadFullResult: (toolUseId: string) => Promise<boolean>
}

export const useClaudeSession = (
  client: WorkerDeckClient,
  sessionId: string | undefined,
  options?: UseClaudeSessionOptions,
): UseClaudeSessionResult => {
  const [state, dispatch] = useReducer(
    reduce,
    undefined,
    (): TranscriptState =>
      (options?.cacheTranscript !== false && sessionId !== undefined
        ? readTranscriptCache(transcriptCacheKey(client, sessionId))
        : undefined) ?? initialTranscriptState,
  )
  const [connection, setConnection] = useState<ConnectionState>('reconnecting')
  const [protocolMismatch, setProtocolMismatch] = useState<number | undefined>()
  const [replayTarget, setReplayTarget] = useState<number | undefined>()
  const [resyncSeq, setResyncSeq] = useState(0)
  // Ref for the stable callbacks below; state so consumers of `handle` re-render when the socket opens or the session switches.
  const [handleState, setHandleState] = useState<SessionHandle | undefined>()
  const handleRef = useRef<SessionHandle | null>(null)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const stateRef = useRef(state)
  stateRef.current = state
  const seededForRef = useRef(attachSeedToken(0, sessionId === undefined ? '' : transcriptCacheKey(client, sessionId)))
  const skipCacheRef = useRef(false)

  useEffect(() => {
    if (!sessionId) {
      return
    }
    const cache = optionsRef.current?.cacheTranscript !== false
    const key = transcriptCacheKey(client, sessionId)
    const plan = planAttach({
      resyncSeq,
      key,
      seededFor: seededForRef.current,
      current: stateRef.current,
      cacheEnabled: cache,
      skipCache: skipCacheRef.current,
      warm: readTranscriptCache(key),
    })
    skipCacheRef.current = false
    if (plan.seed) {
      dispatch({ type: 'transcript_seed', state: plan.held })
      seededForRef.current = plan.seedToken
    }
    const handle = client.attach(sessionId, {
      truncateResults: true,
      imageRefs: true,
      ...(plan.afterSeq === undefined ? {} : { afterSeq: plan.afterSeq }),
    })
    handleRef.current = handle
    setHandleState(handle)
    const offEvent = handle.on('event', (event: SessionEvent) => dispatch(event))
    const offAttached = handle.on('attached', (frame: AttachedFrame) => {
      if (staleAttach(frame, stateRef.current)) {
        offEvent()
        deleteTranscriptCache(key)
        skipCacheRef.current = true
        setResyncSeq((n) => n + 1)
        return
      }
      dispatch(frame)
      setReplayTarget(initialReplayTarget(frame))
      setProtocolMismatch(frame.protocolVersion === PROTOCOL_VERSION ? undefined : frame.protocolVersion)
    })
    const offConn = handle.on('connectionChange', (open: boolean) => setConnection(open ? 'live' : 'reconnecting'))
    const offRetry = handle.on('reconnectAttempt', (attempts: number) =>
      setConnection(attempts >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting'),
    )
    const offProtocolError = handle.on('protocolError', (message: string) => {
      optionsRef.current?.onProtocolError?.(message)
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
      setReplayTarget(undefined)
      const parting = stateRef.current
      if (shouldWriteParting({ cacheEnabled: cache, skipCache: skipCacheRef.current, parting })) {
        writeTranscriptCache(key, parting)
      }
    }
  }, [client, sessionId, resyncSeq])

  useEffect(() => {
    if (replayTarget === undefined) {
      return
    }
    const timer = setTimeout(() => setReplayTarget(undefined), REPLAY_HOLD_MAX_MS)
    return () => clearTimeout(timer)
  }, [replayTarget])
  useEffect(() => {
    if (replayTarget !== undefined && state.lastSeq >= replayTarget) {
      setReplayTarget(undefined)
    }
  }, [replayTarget, state.lastSeq])

  const models = useProfileModelFallback(client, sessionId, state)

  const connected = connection === 'live'
  // Derived at render, not in an effect, so the reveal lands in the same commit as the replay's final event — an effect is one visible frame late.
  const replaying = replayTarget !== undefined && state.lastSeq < replayTarget
  const reconnectNow = useCallback(() => handleRef.current?.reconnectNow(), [])

  const loadFullResult = useCallback(
    async (toolUseId: string): Promise<boolean> => {
      if (!sessionId) {
        return false
      }
      const item = stateRef.current.items.find((candidate) => candidate.kind === 'tool_call' && candidate.id === toolUseId)
      const result = item?.kind === 'tool_call' ? item.result : undefined
      if (!result?.truncated || result.sourceSeq === undefined) {
        return false
      }
      try {
        const full = await client.toolResult(sessionId, result.sourceSeq, toolUseId)
        const text =
          typeof full.content === 'string'
            ? full.content
            : (full.content ?? [])
                .map((part) => (typeof part.text === 'string' ? part.text : ''))
                .filter(Boolean)
                .join('\n')
        dispatch({ type: 'transcript_hydrate_result', toolUseId, text })
        return true
      } catch {
        return false
      }
    },
    [client, sessionId],
  )

  return useMemo(
    () => ({
      state,
      connected,
      connection,
      replaying,
      protocolMismatch,
      models,
      effectiveModel: state.model ?? state.defaultModel,
      handle: handleState,
      send: (text, attachmentIds) => handleRef.current?.send(text, attachmentIds),
      approve: (requestId, updatedInput) => handleRef.current?.approve(requestId, updatedInput),
      deny: (requestId, message, interrupt) => handleRef.current?.deny(requestId, message, interrupt),
      interrupt: () => handleRef.current?.interrupt(),
      clearContext: () => handleRef.current?.clearContext(),
      setPermissionMode: (mode) => handleRef.current?.setPermissionMode(mode),
      setModel: (model) => handleRef.current?.setModel(model),
      closeSession: () => handleRef.current?.closeSession(),
      reconnectNow,
      loadFullResult,
    }),
    [state, connected, connection, replaying, protocolMismatch, models, handleState, reconnectNow, loadFullResult],
  )
}

const useProfileModelFallback = (client: WorkerDeckClient, sessionId: string | undefined, state: TranscriptState): ModelOption[] => {
  const [catalog, setCatalog] = useState<ModelOption[]>([])
  const profile = state.session?.profile
  const reported = state.models
  const hasReported = !!reported?.length

  useEffect(() => setCatalog([]), [sessionId])

  useEffect(() => {
    if (!profile || hasReported) {
      return
    }
    let cancelled = false
    client
      .listProfiles()
      .then((response) => {
        if (!cancelled) {
          setCatalog(response.profiles.find((p) => p.name === profile)?.models ?? [])
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [client, profile, hasReported])

  return hasReported ? reported : catalog
}
