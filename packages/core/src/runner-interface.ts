import type { McpServerStatusInfo, PermissionMode, PermissionRequest, ProfileEngine, SessionEvent, SessionInfo } from '@workerdeck/protocol'
import type { SandboxVfs } from '@workerdeck/sandbox'
import type { AttachmentInput } from './lib/attachments.ts'
import type { ToolExecutionResult } from './executors/tool-executor.ts'

export type SessionEventListener = (event: SessionEvent) => void

/** One deferred execution a parked session is waiting on. */
export type ParkedExecution = {
  executionId: string
  toolName: string
  /** Epoch ms the host's execution watchdog should fire at, when the backend set one. */
  expiresAt?: number
}

/**
 * Everything needed to rebuild a torn-down session under the same id. `state` is
 * the engine's own continuation state and is **opaque** outside it — that opacity
 * is what lets `packages/server` persist a provider session without importing a
 * model SDK. Must round-trip `JSON.stringify` *unchanged*: a Date, Map or typed
 * array inside `state` rehydrates wrong, and only the in-memory store hides that.
 */
export type RunnerSnapshot = {
  /** Engine that produced it. Rehydrating into a different one is refused. */
  engine: ProfileEngine
  /** Session id the rebuilt runner must adopt. */
  id: string
  createdAt: number
  /** Last emitted seq — the rebuilt runner continues numbering from here, so a
   * client reattaching with `afterSeq` sees one unbroken stream. */
  seq: number
  /** The seq-numbered event log, replayed to clients on rehydration. */
  events: SessionEvent[]
  /** Scratch filesystem contents, for engines that have one. */
  vfs?: Record<string, string>
  /** The deferred executions this session parked on. */
  parked: ParkedExecution[]
  /** Engine-private continuation state. Never inspected by the host. */
  state: unknown
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

/**
 * Engine-independent runner surface — exactly what the server and queue consume.
 * `SessionRunner` (Claude / Agent SDK) implements it today; additional engines
 * implement the same contract and are selected behind it. Engine-specific
 * machinery (SDK options, approval callbacks, input-queue shapes) stays inside
 * the implementations.
 */
export interface Runner {
  readonly id: string
  readonly pendingApprovals: PermissionRequest[]
  /** The session's scratch filesystem, when its engine has one. The server's
   * file routes (GET /sessions/:id/files[...]) read it to serve deliverables;
   * engines without a VFS (the Claude CLI engine) simply don't expose it. */
  readonly vfs?: SandboxVfs
  /** Begin the session. Idempotent; returns the run promise (resolves when the run ends). */
  start(): Promise<void>
  info(): SessionInfo
  /** Replay buffered events with seq > afterSeq, then deliver live events. Returns unsubscribe.
   *
   * All three filters are opt-in and defaults must stay off; the stored log is
   * never touched (full story: docs/GOTCHAS.md §Attach replay).
   *
   * `coalesceReplay` drops state readings superseded later in the same replay —
   * only sound for a last-write-wins consumer; `parking.ts` (subscribed from
   * seq 0) branches on `status_changed` instead. Replay-only.
   *
   * `truncateResults` delivers an oversized `tool_result` block as its head plus
   * markers ({@link TOOL_RESULT_HEAD_CHARS}), the rest one fetch away. The
   * opt-in must be issued by the unit that renders, or a head shows as though
   * it were the whole result. Replay-only.
   *
   * `imageRefs` replaces base64 image parts with `image_ref` addresses, bytes
   * one REST fetch away. Same renderer-issued rule, but it applies to **live
   * events as well as replay** — the client's one render path is ref-then-fetch. */
  subscribe(
    listener: SessionEventListener,
    afterSeq?: number,
    options?: { coalesceReplay?: boolean; truncateResults?: boolean; imageRefs?: boolean },
  ): () => void
  /** One buffered event by seq, or undefined. Optional: a runner that declines
   * it declines only the on-demand tool result (the route 404s). Deliberately
   * not a whole-log accessor — that would invite a second copy of the bytes
   * `truncateResults` exists to stop shipping. */
  eventAt?(seq: number): SessionEvent | undefined
  /** Queue a user message for the session (starts the next turn when idle).
   * `attachments` carry their bytes to the engine and their reference to the
   * event log (see {@link AttachmentInput}). */
  sendMessage(text: string, attachments?: readonly AttachmentInput[]): void
  /** Live MCP server status. Resolves undefined when the engine cannot answer
   * (no MCP surface, or a fake query in tests); omitted entirely by engines that
   * have no MCP at all. */
  mcpServers?(): Promise<McpServerStatusInfo[] | undefined>
  /** Reconnect one MCP server by name. Throws if it fails. */
  reconnectMcpServer?(name: string): Promise<void>
  /** Enable or disable one MCP server by name. Throws if it fails. */
  setMcpServerEnabled?(name: string, enabled: boolean): Promise<void>
  /** Set (or clear, with undefined) the host's display title — `meta.title`, which
   * `info().title` prefers over the derived one. A host-facing edit only: nothing
   * is sent to the engine. */
  setTitle(title: string | undefined): void
  /** Resolve a pending permission request. Returns false if the id is unknown (e.g. timed out). */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  interrupt(): Promise<void>
  /**
   * Reset the conversation in place: same id, same watermarks, empty engine
   * context, announced with a `conversation_reset` event (whose replay rules —
   * `transcriptContent` in `@workerdeck/protocol` — stop an attaching client
   * from resurrecting the cleared rows). Optional; declining it is what
   * `EngineCapabilities.clearContext: false` tells clients to expect.
   * **Queues behind in-flight work rather than racing it** — a clear must not
   * land in the middle of the turn it was clearing.
   */
  clearContext?(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** Switch the model for subsequent responses; undefined = back to the default. */
  setModel(model?: string): Promise<void>
  /** Deliver the terminal result of an out-of-band tool execution (e.g. a bridged
   * call answered by a browser client). Optional: engines that never execute
   * out-of-band simply don't expose it. Idempotent by executionId — unknown or
   * already-settled ids return false. */
  settleExecution?(executionId: string, result: ToolExecutionResult): boolean
  /**
   * Park: capture durable state, release engine resources, and go inert — without
   * ending the session (no `session_closed`; the status becomes `parked`). The host
   * persists the snapshot, drops the runner, and rebuilds it under the same id when
   * a deferred execution's result arrives.
   *
   * Returns undefined when parking is not possible right now — a turn is in flight,
   * nothing is actually parked, or the engine doesn't support it (the Claude engine
   * doesn't: the CLI owns its own process state).
   */
  park?(): RunnerSnapshot | undefined
  /**
   * `park()`'s value **without its teardown** — the runner stays live, attached
   * and warm; what lets an engine with no on-disk session survive a restart.
   * The host writes it through after each turn, never on a shutdown hook (a
   * `kill -9` runs no hook, and that is precisely the case worth surviving),
   * and rebuilds through the ordinary `restore` path. Returns undefined when it
   * would capture a half-happened turn: one in flight, or pending in-process
   * executions whose results die with the process. Optional for the same reason
   * `park()` is.
   */
  snapshot?(): RunnerSnapshot | undefined
  /** Emit a session_error and terminate. For host-enforced policy (e.g. requireApiKey). */
  fail(message: string): void
  /** Terminate the session and any underlying engine process. */
  close(reason?: 'client' | 'server' | 'error'): void
}
