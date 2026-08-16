import { ENGINE_CAPABILITIES, mergeUsage, orderUsageWindows } from '@workerdeck/protocol'
import type {
  ContentBlock,
  ContextUsage,
  EngineCapabilities,
  FilePatch,
  MessageAttachment,
  ModelOption,
  PermissionMode,
  PermissionRequest,
  ProfileEngine,
  RateLimitInfo,
  SessionEvent,
  SessionInfo,
  SessionStatus,
  SkillInfo,
  SlashCommandInfo,
  ToolExecutionBackend,
  ToolExecutionOutput,
  ToolResultBlock,
  UsageWindowRow,
} from '@workerdeck/protocol'

/**
 * Pure transcript state machine over the wire-protocol event stream. Framework-free
 * so it can be unit-tested and reused outside React.
 */

export type TranscriptItem =
  | {
      kind: 'user'
      id: string
      text: string
      attachments?: MessageAttachment[]
      /**
       * The `Task` call this prompt was addressed to, when it is a subagent's
       * brief rather than something a person typed.
       *
       * Optional where the other kinds carry it as `string | null`, and the
       * asymmetry is the point: on those it is a fact about every instance, so
       * forgetting to stamp it should not typecheck. Here the overwhelming case
       * is a human prompt, which has no parent at all — `undefined` says that,
       * where `null` on 24 construction sites would only say "somebody
       * remembered".
       */
      parentToolUseId?: string
    }
  | {
      kind: 'assistant_text'
      id: string
      text: string
      streaming: boolean
      parentToolUseId: string | null
    }
  | { kind: 'thinking'; id: string; text: string; parentToolUseId: string | null }
  | {
      kind: 'tool_call'
      id: string
      name: string
      input: unknown
      parentToolUseId: string | null
      /**
       * - `running` — the model called it; execution has not been reported
       * - `pending` — dispatched to an executor (bridged to this client, queued)
       * - `deferred` — parked beyond this turn; may outlive the session's liveness
       * - `settled` / `failed` — terminal
       *
       * Derive UI from this, not from `result` being present: a pending or
       * deferred call has no result yet and is not the same as a running one.
       */
      status: 'running' | 'pending' | 'deferred' | 'settled' | 'failed'
      result?: { text: string; isError: boolean }
      /**
       * What this call changed on disk, when it was a file edit — the engine's
       * own hunks and line numbers (see protocol's {@link FilePatch}).
       *
       * Only ever set from the wire. A client cannot derive it: it has never
       * seen the file, so a diff it computed from the tool's *input* would have
       * no line numbers, and one parsed out of the result prose would be welded
       * to an engine's text formatting.
       */
      patch?: FilePatch
      /** Correlation id when this call is executed outside the model loop. */
      executionId?: string
      /** Which backend is executing it, when known. */
      backend?: ToolExecutionBackend
      /** Logs captured by the executor (guest console output). */
      logs?: string[]
    }
  | {
      kind: 'turn_result'
      id: string
      subtype: string
      isError: boolean
      durationMs: number
      totalCostUsd: number
      errors?: string[]
    }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }
  /** The agent handed over a session file (`file_delivered`). Render a download
   * card; the file is served by GET /sessions/:id/files/<path> while the
   * session lives. */
  | { kind: 'file_delivered'; id: string; path: string; bytes: number; description?: string }

/** A `file_produced` announcement, as the transcript keeps it. */
export type ProducedFileRef = {
  fileId: string
  mediaType?: string
  bytes?: number
}

export type TranscriptState = {
  status: SessionStatus
  statusDetail?: string
  model?: string
  cwd?: string
  sdkSessionId?: string
  /** Engine running the session, from the attach snapshot. Gates CLI-only
   * affordances; absent (an older server) reads as 'claude'. */
  engine?: ProfileEngine
  /**
   * What this session's engine does and does not do: the runner-reported record
   * from the attach snapshot when present, else {@link ENGINE_CAPABILITIES} for
   * the engine. Always defined, so a surface can render every affordance from it
   * rather than switching on the engine name — an absent capability means the
   * affordance is *hidden*, never a control that silently does nothing.
   */
  capabilities: EngineCapabilities
  /**
   * The most recent attach snapshot, whole. The session-level facts no event
   * carries — profile, apiKeySource, canBypassPermissions, createdAt, numTurns —
   * live only here. Unlike the fields above it is replaced on every attach: it is
   * the server's answer, not something the event stream refines.
   */
  session?: SessionInfo
  /** Models the session can switch to (from the `capabilities` event). */
  models?: ModelOption[]
  /** Slash commands the CLI accepts (from the `capabilities` event). */
  commands?: SlashCommandInfo[]
  /**
   * Skills the engine can reach (from the `skills` event), replaced whole each
   * time. Absent until the engine has enumerated them — which for codex is on
   * its first turn, since listing needs a live child. So gate the affordance on
   * *this being defined*, not on `capabilities.skillsList` alone: the flag says
   * the engine can answer, this says it has.
   *
   * Not commands, and must not be offered as such — see the protocol's
   * `SkillInfo`.
   */
  skills?: SkillInfo[]
  /**
   * Files the engine wrote on the host, keyed by the absolute path it reported
   * (from `file_produced`). A tool card holding a `savedPath` looks itself up
   * here to turn that path into a fetchable id — `client.producedFileUrl` — so
   * the picture renders without the operator having declared a host-file root.
   */
  producedFiles?: Record<string, ProducedFileRef>

  /** What this session's default model resolves to (from `capabilities`). Known
   * before the first turn, which `model` is not — a promptless session has no
   * `system_init` until it is spoken to. */
  defaultModel?: string
  /** Seeded from `system_init`, updated on `permission_mode_changed`. */
  permissionMode?: PermissionMode
  /** Latest context-window snapshot; absent until the first turn completes. */
  contextUsage?: ContextUsage
  /** Latest rate-limit snapshot per window ('five_hour', 'seven_day', ...).
   * Absent for API-key sessions — render nothing, not 0%. */
  rateLimits?: Record<string, RateLimitInfo>
  /**
   * When the newest window reading was *taken* (the event's `ts`), not when this
   * client received it — so a reading replayed on attach is dated honestly
   * rather than as "just now". Updates come one per turn at best, which makes a
   * stale reading normal and worth saying out loud.
   */
  rateLimitsUpdatedAt?: number
  /** claude.ai plan the rate-limit windows belong to ('pro', 'max', ...), from
   * `plan_info`. Absent for API-key sessions, like the windows themselves. */
  subscriptionType?: string
  items: TranscriptItem[]
  pendingApprovals: PermissionRequest[]
  totalCostUsd: number
  lastSeq: number
}

export const initialTranscriptState: TranscriptState = {
  status: 'starting',
  // The protocol's own default for an absent `engine`, so a surface has a record
  // to render from before the first attach frame lands.
  capabilities: ENGINE_CAPABILITIES.claude,
  items: [],
  pendingApprovals: [],
  totalCostUsd: 0,
  lastSeq: 0,
}

/**
 * The in-flight streamed text and thought — a singleton **per agent**, not per
 * session.
 *
 * It was one id for the whole stream, which was right while one thread streamed
 * at a time. It is not: with subagent text forwarded, a `Task` and the thread
 * that spawned it stream *concurrently*, and three parallel Tasks stream three
 * ways at once. Under one id every one of those deltas accumulates into the same
 * item — a row welding several agents' half-sentences together — and the first
 * `assistant_message` to land wipes all of them, including the ones still being
 * written.
 *
 * So the id carries the agent: `streaming` for the main thread (unchanged, so
 * nothing that keys off it moves) and `streaming:<parentToolUseId>` inside a
 * subagent.
 */
const STREAMING_ID = 'streaming'
const STREAMING_THINKING_ID = 'streaming-thinking'
const streamingTextId = (parentToolUseId: string | null): string =>
  parentToolUseId == null ? STREAMING_ID : `${STREAMING_ID}:${parentToolUseId}`
const streamingThinkingId = (parentToolUseId: string | null): string =>
  parentToolUseId == null ? STREAMING_THINKING_ID : `${STREAMING_THINKING_ID}:${parentToolUseId}`
/** Is this item an in-flight stream — anyone's? The turn's end finalizes every
 * one of them, since a subagent's last text is as unrecoverable as the main
 * thread's when a turn is interrupted. */
const isStreamingItem = (item: TranscriptItem): boolean =>
  (item.kind === 'assistant_text' && item.id.startsWith(STREAMING_ID)) ||
  (item.kind === 'thinking' && item.id.startsWith(STREAMING_THINKING_ID))

function blockText(content: ToolResultBlock['content']): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function contentToBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

/** Render an execution's by-value output for the transcript. */
function outputText(output: ToolExecutionOutput): string {
  if (output.type === 'text') return output.value
  try {
    return JSON.stringify(output.value)
  } catch {
    return String(output.value)
  }
}

/** CLI-side command output arrives as user text wrapped in local-command tags. */
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/

/**
 * A slash command the person ran, as the CLI writes it into the transcript:
 * `<command-message>…</command-message><command-name>/wrapup</command-name>
 * <command-args>…</command-args>`, in whichever order.
 *
 * Rendered as the command line rather than hidden. It *is* a person's turn — it
 * is the reason everything after it happened — but the raw wrapper is markup
 * nobody typed, and it showed up verbatim in every resumed transcript. Not
 * suppressed in the runner for that same reason: hiding it would erase the
 * turn's cause and, since `transcriptActivity` counts a non-synthetic user
 * message as one row, silently disagree with the unread count.
 */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/

/** The typed command line, or undefined when this is ordinary prose. */
function slashCommandText(text: string): string | undefined {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  if (!name) return undefined
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

function upsert(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id && existing.kind === item.kind)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

/**
 * Seed transcript state from the attach snapshot (the `attached` frame's SessionInfo).
 * A promptless session emits no `system_init` until its first message, so fields like
 * `permissionMode` and `model` would otherwise stay empty — fill only what events
 * haven't set yet; the event stream stays authoritative.
 */
export function seedFromSessionInfo(state: TranscriptState, info: SessionInfo): TranscriptState {
  // Never changes for a live session, and no event carries it — the snapshot is
  // the only source, so take it whenever it is present.
  const engine = info.engine ?? state.engine
  return {
    ...state,
    // Before any event has arrived, the snapshot status is fresher than 'starting'.
    // With state already held (a reconnect, or a warm transcript-cache seed) the
    // held status stands: any change since is a `status_changed` in the replay
    // span — state-bearing, always replayed, last occurrence kept — arriving on
    // the same socket flush as this frame, so the event stream stays the one
    // authority instead of a snapshot racing it.
    status: state.lastSeq === 0 ? info.status : state.status,
    model: state.model ?? info.model,
    permissionMode: state.permissionMode ?? info.permissionMode,
    cwd: state.cwd ?? info.cwd,
    sdkSessionId: state.sdkSessionId ?? info.sdkSessionId,
    engine,
    // The wire copy wins over the static default when both exist, per the
    // protocol — the runner knows what it actually wired up.
    capabilities: info.capabilities ?? ENGINE_CAPABILITIES[engine ?? 'claude'],
    session: info,
  }
}

/**
 * The session's rate-limit windows in reading order: the session window, the
 * weekly window, then whichever per-model weekly windows it reports.
 *
 * The ordering and the drop-the-unknown rule are protocol's `orderUsageWindows`
 * — the dashboard renders the same windows straight off `ProfileInfo.usage`,
 * with no transcript anywhere near it, and two orderings would be one account
 * described two ways. This stays as the transcript-shaped door to it.
 */
export function rateLimitWindows(state: TranscriptState): UsageWindowRow[] {
  return orderUsageWindows(
    mergeUsage({ rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt }, undefined),
  )
}

export function applyEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  if (event.seq <= state.lastSeq) return state
  const base: TranscriptState = { ...state, lastSeq: event.seq }

  switch (event.type) {
    case 'system_init':
      return {
        ...base,
        model: event.model,
        cwd: event.cwd,
        sdkSessionId: event.sdkSessionId,
        permissionMode: event.permissionMode,
      }

    case 'status_changed':
      return { ...base, status: event.status, statusDetail: event.detail }

    case 'capabilities':
      return {
        ...base,
        models: event.models,
        commands: event.commands,
        defaultModel: event.defaultModel ?? base.defaultModel,
      }

    case 'skills':
      // Replaced whole, never merged: the event is the engine's current answer,
      // so a skill deleted on disk has to be able to disappear from the list.
      return { ...base, skills: event.skills }

    case 'file_produced':
      // Keyed by PATH, not by fileId, because the lookup a card does is
      // "here is the savedPath in my tool input — is there anything to fetch?".
      return {
        ...base,
        producedFiles: {
          ...base.producedFiles,
          [event.path]: {
            fileId: event.fileId,
            ...(event.mediaType ? { mediaType: event.mediaType } : {}),
            ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
          },
        },
      }

    case 'model_changed':
      // undefined = reset to the server default; keep showing the last known model.
      return event.model === undefined ? base : { ...base, model: event.model }

    case 'permission_mode_changed':
      return { ...base, permissionMode: event.mode }

    case 'context_usage':
      return { ...base, contextUsage: event.usage }

    case 'rate_limit': {
      // Keyed by window so five_hour and seven_day updates don't clobber each other.
      const key = event.info.rateLimitType
      if (!key) return base
      return {
        ...base,
        rateLimits: { ...base.rateLimits, [key]: event.info },
        rateLimitsUpdatedAt: event.ts,
      }
    }

    case 'plan_info':
      return { ...base, subscriptionType: event.subscriptionType }

    case 'conversation_reset':
      // Same session, fresh conversation (/clear, plan-mode exit). Only
      // conversation-scoped state resets: the items, the context reading (the
      // window now holds an almost-empty conversation; the runner re-polls),
      // and the engine session id when the event names the new one. Everything
      // session-scoped survives — models/commands/skills, produced files (still
      // fetchable), rate limits and plan (account-level), cwd, model,
      // permission mode, cumulative cost — and so do pending approvals: the
      // runner still holds them and they still need answering.
      return {
        ...base,
        items: [],
        contextUsage: undefined,
        sdkSessionId: event.sdkSessionId ?? base.sdkSessionId,
      }

    case 'user_message': {
      let items = base.items
      for (const block of contentToBlocks(event.message.content)) {
        if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock
          const isError = toolResult.is_error === true
          items = items.map((item) =>
            item.kind === 'tool_call' && item.id === toolResult.tool_use_id
              ? {
                  ...item,
                  status: isError ? 'failed' : 'settled',
                  result: { text: blockText(toolResult.content), isError },
                  // Absent on most results; the runner sets it only for a file
                  // edit, and only when the message answers one call.
                  ...(event.patch && { patch: event.patch }),
                }
              : item,
          )
        } else if (block.type === 'text' && !event.synthetic) {
          const text = (block as { text: string }).text
          const localOutput = LOCAL_COMMAND_OUTPUT.exec(text.trim())
          if (localOutput) {
            items = upsert(items, {
              kind: 'notice',
              id: event.uuid ?? `user-${event.seq}`,
              level: localOutput[1] === 'stderr' ? 'error' : 'info',
              text: localOutput[2].trim(),
            })
          } else {
            items = upsert(items, {
              kind: 'user',
              id: event.uuid ?? `user-${event.seq}`,
              // A slash command reads as the command line, not as the wrapper
              // the CLI stored it in.
              text: slashCommandText(text) ?? text,
              // References, not bytes — render them by fetching
              // `/sessions/:id/attachments/:attachmentId`.
              attachments: event.attachments,
              // A subagent's brief arrives here too — a real, non-synthetic
              // user message with a parent. Unstamped it renders as a `❯`
              // prompt row in the main thread, which reads as something the
              // person typed and is the one row in a transcript that must
              // never be wrong about who said it.
              ...(event.parentToolUseId != null && {
                parentToolUseId: event.parentToolUseId,
              }),
            })
          }
        }
      }
      return { ...base, items }
    }

    case 'assistant_message': {
      // Encrypted thinking arrives as a signature-only block on the final message: `thinking`
      // is '' and the human-readable summary, when the model surfaces one at all, exists only
      // in the thinking_delta stream. Carry the streamed text over rather than let the full
      // message overwrite it with nothing.
      const streamingText = streamingTextId(event.parentToolUseId)
      const streamingThought = streamingThinkingId(event.parentToolUseId)
      let streamedThinking =
        base.items.find(
          (item): item is Extract<TranscriptItem, { kind: 'thinking' }> =>
            item.kind === 'thinking' && item.id === streamingThought,
        )?.text ?? ''
      // The full message supersedes any in-flight streamed text/thinking — this
      // agent's, and only this agent's. A subagent's finished message must not
      // wipe the sentence its parent is still writing.
      let items = base.items.filter(
        (item) =>
          !(item.kind === 'assistant_text' && item.id === streamingText) &&
          !(item.kind === 'thinking' && item.id === streamingThought),
      )
      const blocks = contentToBlocks(event.message.content)
      blocks.forEach((block, index) => {
        const id = `${event.uuid}-${index}`
        if (block.type === 'text') {
          items = upsert(items, {
            kind: 'assistant_text',
            id,
            text: (block as { text: string }).text,
            streaming: false,
            parentToolUseId: event.parentToolUseId,
          })
        } else if (block.type === 'thinking') {
          const text = (block as { thinking: string }).thinking || streamedThinking
          // One streamed thought backfills at most one block, so a multi-block message
          // doesn't repeat it.
          streamedThinking = ''
          // No summary anywhere: drop the block instead of leaving a "Thought process" row
          // that expands to nothing (and, across consecutive messages, stacks up).
          if (text.trim() === '') return
          items = upsert(items, {
            kind: 'thinking',
            id,
            text,
            parentToolUseId: event.parentToolUseId,
          })
        } else if (block.type === 'tool_use') {
          const toolUse = block as { id: string; name: string; input: unknown }
          items = upsert(items, {
            kind: 'tool_call',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            parentToolUseId: event.parentToolUseId,
            status: 'running',
          })
        }
      })
      return { ...base, items }
    }

    case 'stream_delta': {
      const delta = event.event as {
        type: string
        delta?: { type?: string; text?: string; thinking?: string }
      }
      if (delta.type !== 'content_block_delta') return base
      if (delta.delta?.type === 'text_delta') {
        const id = streamingTextId(event.parentToolUseId)
        const existing = base.items.find(
          (item): item is Extract<TranscriptItem, { kind: 'assistant_text' }> =>
            item.kind === 'assistant_text' && item.id === id,
        )
        const item: TranscriptItem = {
          kind: 'assistant_text',
          id,
          text: (existing?.text ?? '') + (delta.delta.text ?? ''),
          streaming: true,
          parentToolUseId: event.parentToolUseId,
        }
        return { ...base, items: upsert(base.items, item) }
      }
      if (delta.delta?.type === 'thinking_delta') {
        const id = streamingThinkingId(event.parentToolUseId)
        const existing = base.items.find(
          (item): item is Extract<TranscriptItem, { kind: 'thinking' }> =>
            item.kind === 'thinking' && item.id === id,
        )
        const text = (existing?.text ?? '') + (delta.delta.thinking ?? '')
        // The same guard the finalized block gets, and for the same reason: a
        // `thinking_delta` can carry no visible text at all (an empty or
        // whitespace-only `thinking`, which is what encrypted reasoning looks
        // like on this channel), and a thinking item with a blank body renders
        // as a bare `✻` marker with nothing after it. Worse, it does not go
        // away — `turn_result` finalizes whatever is still streaming under a
        // stable id, so the empty row outlives the turn that produced it.
        // Skipping it here costs nothing: the next delta that does carry text
        // creates the item, since the accumulated text is rebuilt from
        // `existing` each time.
        if (text.trim() === '') return base
        const item: TranscriptItem = {
          kind: 'thinking',
          id,
          text,
          parentToolUseId: event.parentToolUseId,
        }
        return { ...base, items: upsert(base.items, item) }
      }
      return base
    }

    case 'turn_result':
      return {
        ...base,
        // total_cost_usd is session-cumulative on each SDK result message.
        totalCostUsd: event.totalCostUsd,
        items: [
          // The turn is over: whatever is still streaming is this turn's final
          // text — an interrupted or failed turn never sends the
          // assistant_message that normally supersedes it. Finalize it under a
          // stable id, or it stays the singleton streaming item: the *next*
          // turn's message would wipe it (a minute of interrupted output
          // vanishing on the next question) and the next turn's deltas would
          // append to it, gluing two turns' text into one row.
          // Every agent's, not just the main thread's: a subagent interrupted
          // mid-sentence has the same unrecoverable text, and one left under a
          // `streaming:<id>` key would be adopted by the next Task that reused
          // the id. The stable id carries the agent for the same reason the
          // streaming one does — two agents finalizing on one `turn_result`
          // would otherwise land on a single id, and `upsert` keys by id.
          ...base.items.map((item) => {
            if (!isStreamingItem(item)) return item
            const agent = 'parentToolUseId' in item && item.parentToolUseId ? `-${item.parentToolUseId}` : ''
            return item.kind === 'assistant_text'
              ? { ...item, id: `text-${event.seq}${agent}`, streaming: false }
              : { ...item, id: `thinking-${event.seq}${agent}` }
          }),
          {
            kind: 'turn_result',
            id: `turn-${event.seq}`,
            subtype: event.subtype,
            isError: event.isError,
            durationMs: event.durationMs,
            totalCostUsd: event.totalCostUsd,
            errors: event.errors,
          },
        ],
      }

    case 'permission_requested':
      return { ...base, pendingApprovals: [...base.pendingApprovals, event.request] }

    case 'permission_resolved':
      return {
        ...base,
        pendingApprovals: base.pendingApprovals.filter((r) => r.id !== event.requestId),
      }

    // Execution lifecycle for tool calls that run outside the model loop
    // (bridged to this client, queued, or deferred). Keyed by executionId, which
    // equals the tool_use id for calls the model made. Events for an unknown id
    // are ignored rather than fabricating an item: the tool_use that explains it
    // may simply not have arrived (or belongs to another session).
    case 'execution_dispatched':
      return {
        ...base,
        items: base.items.map((item) =>
          item.kind === 'tool_call' && item.id === event.executionId
            ? {
                ...item,
                status: event.deferred ? 'deferred' : 'pending',
                executionId: event.executionId,
                backend: event.backend,
              }
            : item,
        ),
      }

    case 'execution_result':
      return {
        ...base,
        items: base.items.map((item) =>
          item.kind === 'tool_call' && item.id === event.executionId
            ? {
                ...item,
                status: 'settled',
                executionId: event.executionId,
                result: { text: outputText(event.output), isError: false },
                logs: event.logs ?? item.logs,
              }
            : item,
        ),
      }

    case 'execution_failed':
      return {
        ...base,
        items: base.items.map((item) =>
          item.kind === 'tool_call' && item.id === event.executionId
            ? {
                ...item,
                status: 'failed',
                executionId: event.executionId,
                result: { text: `${event.reason}: ${event.error}`, isError: true },
                logs: event.logs ?? item.logs,
              }
            : item,
        ),
      }

    case 'file_delivered':
      return {
        ...base,
        items: [
          ...base.items,
          {
            kind: 'file_delivered',
            id: `file-${event.seq}`,
            path: event.path,
            bytes: event.bytes,
            description: event.description,
          },
        ],
      }

    case 'session_error':
      return {
        ...base,
        items: [
          ...base.items,
          { kind: 'notice', id: `err-${event.seq}`, level: 'error', text: event.message },
        ],
      }

    case 'session_closed':
      return {
        ...base,
        items: [
          ...base.items,
          {
            kind: 'notice',
            id: `closed-${event.seq}`,
            level: 'info',
            text: `Session closed (${event.reason})`,
          },
        ],
      }

    case 'sdk_event':
    default:
      return base
  }
}
