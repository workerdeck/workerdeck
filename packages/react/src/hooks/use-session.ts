import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { WorkerDeckClient, SessionHandle } from '@workerdeck/client'
import { PROTOCOL_VERSION } from '@workerdeck/protocol'
import type { AttachedFrame, ModelOption, PermissionMode, SessionEvent } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, hydrateToolResult, seedFromSessionInfo, type TranscriptState } from '../lib/transcript.ts'
import { deleteTranscriptCache, readTranscriptCache, transcriptCacheKey, writeTranscriptCache } from '../lib/transcript-cache.ts'
import { attachSeedToken, planAttach, shouldWriteParting } from '../lib/attach-plan.ts'

/** Replace the state wholesale — an in-place session switch, or the stale-log
 * resync. Internal to the hook; the wire never carries it. */
type SeedAction = { type: 'transcript_seed'; state: TranscriptState }
/** A fetched tool result landing back on the row that showed its head. Local,
 * not an event: nothing was emitted, and inventing a seq for it would put a
 * frame in the log that no other client will ever see. */
type HydrateAction = { type: 'transcript_hydrate_result'; toolUseId: string; text: string }

/** Session events drive the reducer; the attach snapshot seeds fields (permission
 * mode, model) that a promptless session's event stream doesn't carry yet. */
const reduce = (state: TranscriptState, action: SessionEvent | AttachedFrame | SeedAction | HydrateAction): TranscriptState => {
  if (action.type === 'transcript_seed') {
    return action.state
  }
  if (action.type === 'transcript_hydrate_result') {
    return hydrateToolResult(state, action.toolUseId, action.text)
  }
  return action.type === 'attached' ? seedFromSessionInfo(state, action.session) : applyEvent(state, action)
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

/**
 * The seq the initial attach replay ends on, or undefined when there is nothing
 * to hold for. An exact signal, never a quiet-window or arrival heuristic: the
 * `attached` frame precedes every replayed `event` frame and carries the
 * runner's seq at attach time, and a fresh replay always delivers the
 * highest-seq event, so `TranscriptState.lastSeq >= target` means the replay
 * has landed. Only a FRESH attach (`replayingFrom === 0`) yields a target: a
 * reconnect replays into a transcript the reader is already looking at, and
 * blanking it mid-turn would be a worse bug than the flicker the hold fixes.
 */
export const initialReplayTarget = (frame: AttachedFrame): number | undefined =>
  frame.replayingFrom === 0 && frame.session.lastSeq > 0 ? frame.session.lastSeq : undefined

/**
 * Whether an attach frame describes a DIFFERENT event log than `held` was built from — in which
 * case `afterSeq: held.lastSeq` delivers nothing, forever, with no error. Checked on every attach
 * frame, not just cached ones. See `docs/GOTCHAS.md` §Attach replay.
 */
export const staleAttach = (frame: AttachedFrame, held: TranscriptState): boolean => {
  if (frame.replayingFrom === 0 || held.lastSeq === 0) {
    return false
  }
  if (frame.session.lastSeq < held.lastSeq) {
    return true
  }
  return held.session !== undefined && frame.session.createdAt !== held.session.createdAt
}

/**
 * Backstop for the replay hold: if the target seq has not landed after this
 * long, reveal what has arrived — a blank panel forever is a much worse failure
 * than a visible stream. Runs from the attach; a per-event re-arm would be a
 * quiet-window heuristic in a new costume.
 */
export const REPLAY_HOLD_MAX_MS = 1500

export type UseClaudeSessionOptions = {
  /** Called when the server rejects a command with a protocol_error frame — e.g. a
   * permission-mode switch the CLI refuses. Without a handler these are dropped
   * silently and the UI looks like "nothing happened". */
  onProtocolError?: (message: string) => void
  /**
   * Keep this session's transcript warm after unmount (default true), so the next mount of the
   * same (client identity, session) paints from cache and attaches with `afterSeq`. Read at
   * attach time. Set `false` — or call `clearTranscriptCache()` on logout — for an embedder whose
   * principal varies on one base URL by means the client cannot see.
   */
  cacheTranscript?: boolean
}

export type UseClaudeSessionResult = {
  state: TranscriptState
  /** True while the socket is open. {@link UseClaudeSessionResult.connection}
   * carries the same fact with the "has it been failing a while" distinction. */
  connected: boolean
  connection: ConnectionState
  /**
   * True while the initial attach replay is still landing: the `attached` frame
   * said events up to `session.lastSeq` follow, and they have not all been
   * applied yet. A surface can hold its paint on this — keep the rows mounted
   * and measuring, show nothing — and reveal a settled transcript in one frame,
   * instead of streaming hundreds of replayed rows past the reader. Always
   * false on a reconnect (only a fresh attach holds; see
   * {@link initialReplayTarget}) and bounded by {@link REPLAY_HOLD_MAX_MS}.
   */
  replaying: boolean
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
  /**
   * Reset the conversation in place: same session, empty transcript. Gate the
   * affordance on `session.capabilities?.clearContext` — an engine or a gateway
   * that cannot do it answers with an error, which is the wrong way for a user
   * to find out.
   */
  clearContext: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
  /** Skip the reconnect backoff — what a tab returning to the foreground does. */
  reconnectNow: () => void
  /**
   * Fetch the whole of a tool result the replay delivered as a head, and put it
   * back on its row (`result.truncated` clears with it).
   *
   * Resolves `false` when there was nothing to do — an untruncated row, an
   * unknown id, or a gateway that refused (a stale `sourceSeq` after a dormant
   * rebuild 404s by design; re-attaching is what fixes that, not a retry). It
   * never throws, because the caller is a press on a row and an exception there
   * has nowhere sensible to go.
   */
  loadFullResult: (toolUseId: string) => Promise<boolean>
}

/** Attach to a session and maintain live transcript state. Detaches on unmount. */
export const useClaudeSession = (
  client: WorkerDeckClient,
  sessionId: string | undefined,
  options?: UseClaudeSessionOptions,
): UseClaudeSessionResult => {
  // Seeded from the transcript cache when this (client identity, session) was
  // viewed recently — the cached rows are the mount frame's paint, which is the
  // whole "switching back is instant" feature. A cold key starts blank as before.
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
  /** Where the current attach's replay ends, while one is being held for. */
  const [replayTarget, setReplayTarget] = useState<number | undefined>()
  /** Bumped to force a fresh attach from seq 0 after a stale-log detection. */
  const [resyncSeq, setResyncSeq] = useState(0)
  // Ref for the stable callbacks below; state so consumers of `handle` re-render
  // when the socket opens or the session switches.
  const [handleState, setHandleState] = useState<SessionHandle | undefined>()
  const handleRef = useRef<SessionHandle | null>(null)
  // Ref'd so a new inline callback doesn't tear down and reopen the socket.
  const optionsRef = useRef(options)
  optionsRef.current = options
  // The latest rendered state, for the attach effect and its cleanup — both run
  // outside render and must see what the transcript actually holds.
  const stateRef = useRef(state)
  stateRef.current = state
  // Which (resync, client identity, session) the reducer state belongs to. The
  // initializer above seeded for the mount's token; the effect re-seeds when its
  // token differs (an in-place session switch, or a resync).
  const seededForRef = useRef(attachSeedToken(0, sessionId === undefined ? '' : transcriptCacheKey(client, sessionId)))
  // True from a stale-log detection until the next attach: the cleanup must not
  // write the condemned state back into the cache (it would re-poison the very
  // retry that just discarded it), and the retry must attach cold even if some
  // other mount re-wrote the entry meanwhile.
  const skipCacheRef = useRef(false)

  useEffect(() => {
    if (!sessionId) {
      return
    }
    const cache = optionsRef.current?.cacheTranscript !== false
    const key = transcriptCacheKey(client, sessionId)
    // Every decision lives in planAttach, pure and unit-tested — this hook
    // never renders in a test (the package carries no jsdom, by design). The
    // effect only reads its refs into inputs and applies the plan.
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
    // `truncateResults` and `imageRefs` are asked for HERE, and here only: this
    // hook is the unit that renders, so it is the one that knows a head can be
    // fetched back and an address loaded. An embedder holding `client` without
    // `react` gets whole results — the safe default.
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
        // Wrong log (dormant rebuild, restart). Stop listening NOW — a rebuilt
        // log that advanced past us replays new-log events in this same tick,
        // and they must not compose into old-log state — forget everything,
        // and re-attach from seq 0. Cannot loop: the retry ignores the cache
        // and attaches with afterSeq 0, for which staleAttach is false by
        // definition.
        offEvent()
        deleteTranscriptCache(key)
        skipCacheRef.current = true
        setResyncSeq((n) => n + 1)
        return
      }
      dispatch(frame)
      // A reconnect's frame (`replayingFrom > 0`) computes to undefined, which
      // also RELEASES a hold whose replay was cut short by a socket drop: the
      // re-attach picks up from whatever landed, streaming the rest visibly
      // rather than holding for a target the first socket never delivered.
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
      // Keep the transcript warm for a switch-back — when shouldWriteParting
      // allows it (the guards, and the bugs each one prevents, live on that
      // function).
      const parting = stateRef.current
      if (shouldWriteParting({ cacheEnabled: cache, skipCache: skipCacheRef.current, parting })) {
        writeTranscriptCache(key, parting)
      }
    }
  }, [client, sessionId, resyncSeq])

  // The hold's backstop. Armed once per hold (the target is set exactly once,
  // at the attach) and NOT re-armed per event — that would be a quiet-window
  // latch, the thing this design exists to not be. When the target is reached
  // the derived `replaying` below flips false in that same render; this state
  // is then cleared so the next attach starts clean.
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
  // Derived at render, not in an effect, so the reveal happens in the SAME
  // commit that applies the replay's final event — an effect would reveal one
  // render late, and that render is a visible frame.
  const replaying = replayTarget !== undefined && state.lastSeq < replayTarget
  const reconnectNow = useCallback(() => handleRef.current?.reconnectNow(), [])

  // The seq comes off the *item* (`result.sourceSeq`), never off anything the
  // caller passes — a caller-carried seq invites a stale one from a cache.
  // Reads through `stateRef` so the identity is stable: it is a prop on every
  // virtualized row.
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
        // A 404 means the log this seq belonged to is gone (dormant rebuild,
        // restart). The head stays with its marker — the honest state, and
        // better than an error toast about a press.
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

/**
 * The session's profile catalog, fetched only when the engine has reported no
 * models of its own. Fire-and-forget on purpose: an empty catalog is exactly
 * the state a picker already handles, so a failed or 404'd `/profiles` (a
 * server predating them) degrades rather than raising an error.
 */
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
      .catch(() => {
        // No catalog: the picker falls back to whatever the session reports.
      })
    return () => {
      cancelled = true
    }
  }, [client, profile, hasReported])

  return hasReported ? reported : catalog
}
