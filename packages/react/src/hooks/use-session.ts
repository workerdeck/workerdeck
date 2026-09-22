import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorkerDeckClient, SessionHandle } from '@workerdeck/client'
import { DEFAULT_PRICING, PROTOCOL_VERSION, mergePricing } from '@workerdeck/protocol'
import type { AttachedFrame, ModelOption, PermissionMode, PricingTable, SessionEvent, ShellInfo } from '@workerdeck/protocol'
import {
  applyEvent,
  blockText,
  initialTranscriptState,
  hydrateShellOutput,
  hydrateShellRow,
  hydrateToolResult,
  seedFromSessionInfo,
  type TranscriptState,
} from '../lib/transcript.ts'
import { deleteTranscriptCache, readTranscriptCache, transcriptCacheKey, writeTranscriptCache } from '../lib/transcript-cache.ts'
import { attachSeedToken, planAttach, shouldWriteParting } from '../lib/attach-plan.ts'

type SeedAction = { type: 'transcript_seed'; state: TranscriptState }
type HydrateAction = { type: 'transcript_hydrate_result'; toolUseId: string; text: string }
type ShellRowAction = { type: 'transcript_hydrate_shell'; shellId: string; shell: ShellInfo | undefined }
type ShellOutputAction = { type: 'transcript_hydrate_shell_output'; shellId: string; text: string }

type TranscriptAction = SessionEvent | AttachedFrame | SeedAction | HydrateAction | ShellRowAction | ShellOutputAction

function reduce(state: TranscriptState, action: TranscriptAction): TranscriptState {
  if (action.type === 'transcript_seed') {
    return action.state
  }
  if (action.type === 'transcript_hydrate_result') {
    return hydrateToolResult(state, action.toolUseId, action.text)
  }
  if (action.type === 'transcript_hydrate_shell') {
    return hydrateShellRow(state, action.shellId, action.shell)
  }
  if (action.type === 'transcript_hydrate_shell_output') {
    return hydrateShellOutput(state, action.shellId, action.text)
  }
  return action.type === 'attached' ? seedFromSessionInfo(state, action.session) : applyEvent(state, action)
}

export type ConnectionState = 'live' | 'reconnecting' | 'offline'

// Three failed attempts is ~3.5s of backoff - past a blip; the iOS client hardcodes the same threshold.
const OFFLINE_AFTER_ATTEMPTS = 3

export function initialReplayTarget(frame: AttachedFrame): number | undefined {
  return frame.replayingFrom === 0 && frame.session.lastSeq > 0 ? frame.session.lastSeq : undefined
}

export function staleAttach(frame: AttachedFrame, held: TranscriptState): boolean {
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
  // The gateway offers `$` shell mode to this principal on this session. Absent from an older gateway, so falsy by default.
  shell: boolean
  // The gateway's rate table, its own overrides merged over the bundled one, for every figure this client prices itself.
  pricing: PricingTable
  models: ModelOption[]
  effectiveModel?: string
  handle: SessionHandle | undefined
  send: (text: string, attachmentIds?: string[]) => void
  approve: (requestId: string, updatedInput?: Record<string, unknown>) => void
  deny: (requestId: string, message?: string, interrupt?: boolean) => void
  interrupt: () => void
  clearContext: () => void
  runShell: (command: string) => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
  reconnectNow: () => void
  loadFullResult: (toolUseId: string) => Promise<boolean>
  // The artifact's text view, fetched for one expanded row. It never reaches the model: the two budgets never touch.
  loadShellOutput: (shellId: string) => Promise<boolean>
  // A `running` row is a claim from the event log, which can be older than the process. Fetched once per shell id.
  verifyShell: (shellId: string) => Promise<boolean>
  killShell: (shellId: string) => Promise<boolean>
}

export function useClaudeSession(
  client: WorkerDeckClient,
  sessionId: string | undefined,
  options?: UseClaudeSessionOptions,
): UseClaudeSessionResult {
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
  const [shell, setShell] = useState(false)
  const [pricing, setPricing] = useState<PricingTable>(DEFAULT_PRICING)
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
      setShell(frame.shell === true)
      setPricing(mergePricing(frame.pricingOverrides).pricing)
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
      setShell(false)
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
  // Derived at render, not in an effect, so the reveal lands in the same commit as the replay's final event - an effect is one visible frame late.
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
        dispatch({ type: 'transcript_hydrate_result', toolUseId, text: blockText(full.content) })
        return true
      } catch {
        return false
      }
    },
    [client, sessionId],
  )

  const verifiedRef = useRef(new Set<string>())
  useEffect(() => {
    verifiedRef.current = new Set<string>()
  }, [sessionId])

  const loadShellOutput = useCallback(
    async (shellId: string): Promise<boolean> => {
      if (!sessionId) {
        return false
      }
      try {
        const text = await client.shellOutput(sessionId, shellId, { view: 'text' })
        dispatch({ type: 'transcript_hydrate_shell_output', shellId, text })
        return true
      } catch {
        dispatch({ type: 'transcript_hydrate_shell', shellId, shell: undefined })
        return false
      }
    },
    [client, sessionId],
  )

  const verifyShell = useCallback(
    async (shellId: string): Promise<boolean> => {
      if (!sessionId || verifiedRef.current.has(shellId)) {
        return false
      }
      verifiedRef.current.add(shellId)
      try {
        const record = await client.getShell(sessionId, shellId)
        dispatch({ type: 'transcript_hydrate_shell', shellId, shell: record })
        return true
      } catch {
        dispatch({ type: 'transcript_hydrate_shell', shellId, shell: undefined })
        return false
      }
    },
    [client, sessionId],
  )

  const killShell = useCallback(
    async (shellId: string): Promise<boolean> => {
      if (!sessionId) {
        return false
      }
      try {
        const record = await client.killShell(sessionId, shellId)
        dispatch({ type: 'transcript_hydrate_shell', shellId, shell: record })
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
      shell,
      pricing,
      models,
      effectiveModel: state.model ?? state.defaultModel,
      handle: handleState,
      send: (text, attachmentIds) => handleRef.current?.send(text, attachmentIds),
      approve: (requestId, updatedInput) => handleRef.current?.approve(requestId, updatedInput),
      deny: (requestId, message, interrupt) => handleRef.current?.deny(requestId, message, interrupt),
      interrupt: () => handleRef.current?.interrupt(),
      clearContext: () => handleRef.current?.clearContext(),
      runShell: (command) => handleRef.current?.runShell(command),
      setPermissionMode: (mode) => handleRef.current?.setPermissionMode(mode),
      setModel: (model) => handleRef.current?.setModel(model),
      closeSession: () => handleRef.current?.closeSession(),
      reconnectNow,
      loadFullResult,
      loadShellOutput,
      verifyShell,
      killShell,
    }),
    [
      state,
      connected,
      connection,
      replaying,
      protocolMismatch,
      shell,
      pricing,
      models,
      handleState,
      reconnectNow,
      loadFullResult,
      loadShellOutput,
      verifyShell,
      killShell,
    ],
  )
}

function useProfileModelFallback(client: WorkerDeckClient, sessionId: string | undefined, state: TranscriptState): ModelOption[] {
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
