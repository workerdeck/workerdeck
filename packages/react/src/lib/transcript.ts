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

/** An `image_ref` address a tool result carried, as the transcript keeps it. */
export type ToolResultImageRef = { partIndex: number; mediaType: string; bytes: number; sourceSeq: number }

export type TranscriptItem =
  | {
      kind: 'user'
      id: string
      text: string
      attachments?: MessageAttachment[]
      /**
       * The `Task` call this prompt belongs to, when it is a subagent's brief.
       * Optional (not `string | null` like the other kinds) deliberately: there
       * the field is a fact about every instance, so forgetting to stamp it must
       * not typecheck; here the overwhelming case is a human prompt with no
       * parent at all.
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
       * When the model called it — the event's own `ts`, replay-stable rather
       * than a receive time. Stamped at creation only and immutable after
       * (which lets iOS's `Equatable` row-plan cache key mirror it); absent
       * must read as "no elapsed", never as the epoch.
       */
      ts?: number
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
      /**
       * `truncated`/`totalChars`/`sourceSeq` are set **only** when the replay
       * delivered a head (protocol's {@link ToolResultBlock.truncated}), so
       * every other result stays byte-identical (on iOS `ToolCallItem` is
       * `Equatable` and half the row-plan cache key). `sourceSeq` names the
       * event to fetch; all three clear on hydration, so a hydrated result is
       * indistinguishable from one never cut.
       */
      result?: {
        text: string
        isError: boolean
        truncated?: boolean
        totalChars?: number
        sourceSeq?: number
        /**
         * `image_ref` addresses, never bytes — set **only** when the replay
         * delivered them (the byte-identical rule again). Each entry carries
         * its **own** `sourceSeq` because the sibling one clears on text
         * hydration and the pictures must stay loadable after. Raw base64
         * `image` parts are still dropped on arrival: folded in, the transcript
         * LRU would pin megabytes across session switches.
         */
        images?: ReadonlyArray<ToolResultImageRef>
      }
      /**
       * What this call changed on disk, when it was a file edit (protocol's
       * {@link FilePatch}). Only ever set from the wire — a client has never
       * seen the file and cannot derive line-numbered hunks itself.
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
   * The runner-reported capability record from the attach snapshot, else
   * {@link ENGINE_CAPABILITIES} for the engine. Always defined: surfaces render
   * every affordance from it, never by switching on the engine name — an absent
   * capability hides the affordance, never a control that silently does nothing.
   */
  capabilities: EngineCapabilities
  /**
   * The most recent attach snapshot, whole — the session-level facts no event
   * carries (profile, apiKeySource, canBypassPermissions, createdAt, numTurns).
   * Replaced on every attach: it is the server's answer, not something the
   * event stream refines.
   */
  session?: SessionInfo
  /** Models the session can switch to (from the `capabilities` event). */
  models?: ModelOption[]
  /** Slash commands the CLI accepts (from the `capabilities` event). */
  commands?: SlashCommandInfo[]
  /**
   * Skills the engine can reach (from the `skills` event), replaced whole each
   * time. Gate the affordance on *this being defined*, not on
   * `capabilities.skillsList` alone: the flag says the engine can answer, this
   * says it has (codex only enumerates on its first turn). Not commands, and
   * must not be offered as such — see the protocol's `SkillInfo`.
   */
  skills?: SkillInfo[]
  /**
   * Files the engine wrote on the host, keyed by the absolute path it reported
   * (`file_produced`) — the lookup a tool card does is by the `savedPath` in
   * its input, resolved to a fetchable id via `client.producedFileUrl`.
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
  /** When the newest window reading was *taken* (the event's `ts`), not
   * received — a reading replayed on attach is dated honestly. One update per
   * turn at best, so a stale reading is normal. */
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
  // The protocol default for an absent `engine`, so surfaces have a record
  // to render from before the first attach frame lands.
  capabilities: ENGINE_CAPABILITIES.claude,
  items: [],
  pendingApprovals: [],
  totalCostUsd: 0,
  lastSeq: 0,
}

/**
 * In-flight streamed text/thought ids are per **agent**, not per session:
 * `streaming` for the main thread, `streaming:<parentToolUseId>` inside a
 * subagent. Under one id, concurrently streaming agents (a `Task` and the
 * thread that spawned it) weld their deltas into one row, and the first
 * `assistant_message` to land wipes them all.
 */
const STREAMING_ID = 'streaming'
const STREAMING_THINKING_ID = 'streaming-thinking'

/** CLI-side command output arrives as user text wrapped in local-command tags. */
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/

/**
 * A slash command the person ran, as the CLI writes it into the transcript
 * (`<command-name>…</command-name><command-args>…</command-args>`). Rendered as
 * the command line, never hidden: it is the turn's cause, and
 * `transcriptActivity` counts a non-synthetic user message as one row, so
 * suppressing it would silently disagree with the unread count.
 */
const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
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

const blockText = (content: ToolResultBlock['content']): string => {
  if (content === undefined) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

/** The `image_ref` addresses in a result's content — undefined (never an empty
 * array) when it holds none, so the common case stays byte-identical. */
const imageRefsOf = (content: ToolResultBlock['content'], seq: number): ReadonlyArray<ToolResultImageRef> | undefined => {
  if (!Array.isArray(content)) {
    return undefined
  }
  const refs = content.flatMap((part) =>
    part.type === 'image_ref'
      ? [
          {
            partIndex: Number(part.part_index),
            mediaType: String(part.media_type ?? 'application/octet-stream'),
            bytes: Number(part.bytes ?? 0),
            sourceSeq: seq,
          },
        ]
      : [],
  )
  return refs.length > 0 ? refs : undefined
}

const contentToBlocks = (content: string | ContentBlock[]): ContentBlock[] =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content

/** Render an execution's by-value output for the transcript. */
const outputText = (output: ToolExecutionOutput): string => {
  if (output.type === 'text') {
    return output.value
  }
  try {
    return JSON.stringify(output.value)
  } catch {
    return String(output.value)
  }
}

/** The typed command line, or undefined when this is ordinary prose. */
const slashCommandText = (text: string): string | undefined => {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  if (!name) {
    return undefined
  }
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

const upsert = (items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] => {
  const index = items.findIndex((existing) => existing.id === item.id && existing.kind === item.kind)
  if (index === -1) {
    return [...items, item]
  }
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
export const seedFromSessionInfo = (state: TranscriptState, info: SessionInfo): TranscriptState => {
  // No event carries the engine — the snapshot is the only source.
  const engine = info.engine ?? state.engine
  return {
    ...state,
    // Before any event, the snapshot status is fresher than 'starting'. With
    // state already held (reconnect, warm cache seed) the held status stands:
    // any change since is a `status_changed` in the replay span, so the event
    // stream stays the one authority instead of a snapshot racing it.
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
 * The session's rate-limit windows in reading order. The ordering and the
 * drop-the-unknown rule are protocol's `orderUsageWindows` — the dashboard
 * renders the same windows straight off `ProfileInfo.usage`, and two orderings
 * would be one account described two ways.
 */
export const rateLimitWindows = (state: TranscriptState): UsageWindowRow[] =>
  orderUsageWindows(mergeUsage({ rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt }, undefined))

/**
 * Put a fetched tool result back where its head was — the other half of
 * `truncateResults`. Into **transcript state**, not row-local state: the copy
 * button copies the whole thing, the cache retains it across a session switch,
 * and no later event can re-truncate it. The markers are cleared, so a hydrated
 * result is indistinguishable from one never cut. An unknown `toolUseId`
 * returns `state` unchanged — a press answered after the session was cleared
 * must not resurrect a row.
 */
export const hydrateToolResult = (state: TranscriptState, toolUseId: string, text: string): TranscriptState => {
  let changed = false
  const items = state.items.map((item) => {
    if (item.kind !== 'tool_call' || item.id !== toolUseId || !item.result?.truncated) {
      return item
    }
    changed = true
    // `images` survives: hydration answers the *text* press, and clearing the
    // addresses beside it would leave the row's pictures unloadable forever.
    return {
      ...item,
      result: {
        text,
        isError: item.result.isError,
        ...(item.result.images && { images: item.result.images }),
      },
    }
  })
  return changed ? { ...state, items } : state
}

export const applyEvent = (state: TranscriptState, event: SessionEvent): TranscriptState => {
  if (event.seq <= state.lastSeq) {
    return state
  }
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
      if (!key) {
        return base
      }
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
                  result: {
                    text: blockText(toolResult.content),
                    isError,
                    // Set together or not at all: a marker without the seq is a
                    // press that cannot be answered.
                    ...(toolResult.truncated && {
                      truncated: true as const,
                      totalChars: toolResult.total_chars,
                      sourceSeq: event.seq,
                    }),
                    ...(imageRefsOf(toolResult.content, event.seq) && {
                      images: imageRefsOf(toolResult.content, event.seq),
                    }),
                  },
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
          (item): item is Extract<TranscriptItem, { kind: 'thinking' }> => item.kind === 'thinking' && item.id === streamingThought,
        )?.text ?? ''
      // The full message supersedes any in-flight streamed text/thinking — this
      // agent's, and only this agent's. A subagent's finished message must not
      // wipe the sentence its parent is still writing.
      let items = base.items.filter(
        (item) =>
          !(item.kind === 'assistant_text' && item.id === streamingText) && !(item.kind === 'thinking' && item.id === streamingThought),
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
          if (text.trim() === '') {
            return
          }
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
            ts: event.ts,
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
      if (delta.type !== 'content_block_delta') {
        return base
      }
      if (delta.delta?.type === 'text_delta') {
        const id = streamingTextId(event.parentToolUseId)
        const existing = base.items.find(
          (item): item is Extract<TranscriptItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text' && item.id === id,
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
          (item): item is Extract<TranscriptItem, { kind: 'thinking' }> => item.kind === 'thinking' && item.id === id,
        )
        const text = (existing?.text ?? '') + (delta.delta.thinking ?? '')
        // Same guard as the finalized block: encrypted reasoning streams
        // whitespace-only `thinking`, and a blank item renders as a bare `✻`
        // marker that `turn_result` then finalizes into a permanent empty row.
        // Skipping costs nothing — the text is rebuilt from `existing`, so the
        // next delta that does carry text creates the item.
        if (text.trim() === '') {
          return base
        }
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
          // The turn is over: whatever is still streaming is its final text —
          // an interrupted or failed turn never sends the superseding
          // assistant_message. Finalize under a stable id, or the next turn's
          // message wipes it and the next turn's deltas glue onto it. Every
          // agent's, not just the main thread's, and the stable id carries the
          // agent: two agents finalizing on one `turn_result` must not land on
          // a single id (`upsert` keys by id).
          ...base.items.map((item) => {
            if (!isStreamingItem(item)) {
              return item
            }
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
        items: [...base.items, { kind: 'notice', id: `err-${event.seq}`, level: 'error', text: event.message }],
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
