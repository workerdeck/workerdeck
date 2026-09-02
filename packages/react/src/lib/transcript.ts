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

export type ToolResultImageRef = { partIndex: number; mediaType: string; bytes: number; sourceSeq: number }

export type TranscriptItem =
  | {
      kind: 'user'
      id: string
      text: string
      attachments?: MessageAttachment[]
      // Optional, not `string | null` like the other kinds: there forgetting to stamp it must not typecheck; here almost every prompt has no parent.
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
      // The event's own `ts`, never a receive time — replay-stable, stamped at creation only; absent reads as "no elapsed", never as the epoch.
      ts?: number
      status: 'running' | 'pending' | 'deferred' | 'settled' | 'failed'
      result?: {
        text: string
        isError: boolean
        truncated?: boolean
        totalChars?: number
        sourceSeq?: number
        images?: ReadonlyArray<ToolResultImageRef>
      }
      patch?: FilePatch
      executionId?: string
      backend?: ToolExecutionBackend
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
  /**
   * The engine summarised the conversation in place to fit its context window. A boundary, not a
   * message: nothing above it is retracted (that is `conversation_reset`, which empties `items`),
   * and it carries no text of its own because the wire event carries none — codex's
   * `contextCompaction` item is `{id, type}` and nothing more.
   */
  | { kind: 'compaction'; id: string; parentToolUseId: string | null }
  | { kind: 'file_delivered'; id: string; path: string; bytes: number; description?: string }

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
  engine?: ProfileEngine
  capabilities: EngineCapabilities
  session?: SessionInfo
  models?: ModelOption[]
  commands?: SlashCommandInfo[]
  skills?: SkillInfo[]
  // Keyed by the absolute path the runner reported: a tool card looks up the `savedPath` in its input and resolves it via `client.producedFileUrl`.
  producedFiles?: Record<string, ProducedFileRef>

  defaultModel?: string
  permissionMode?: PermissionMode
  contextUsage?: ContextUsage
  rateLimits?: Record<string, RateLimitInfo>
  rateLimitsUpdatedAt?: number
  subscriptionType?: string
  items: TranscriptItem[]
  pendingApprovals: PermissionRequest[]
  totalCostUsd: number
  lastSeq: number
}

export const initialTranscriptState: TranscriptState = {
  status: 'starting',
  capabilities: ENGINE_CAPABILITIES.claude,
  items: [],
  pendingApprovals: [],
  totalCostUsd: 0,
  lastSeq: 0,
}

const STREAMING_ID = 'streaming'
const STREAMING_THINKING_ID = 'streaming-thinking'

const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/

const COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/
function streamingTextId(parentToolUseId: string | null): string {
  return parentToolUseId == null ? STREAMING_ID : `${STREAMING_ID}:${parentToolUseId}`
}
function streamingThinkingId(parentToolUseId: string | null): string {
  return parentToolUseId == null ? STREAMING_THINKING_ID : `${STREAMING_THINKING_ID}:${parentToolUseId}`
}
function isStreamingItem(item: TranscriptItem): boolean {
  return (
    (item.kind === 'assistant_text' && item.id.startsWith(STREAMING_ID)) ||
    (item.kind === 'thinking' && item.id.startsWith(STREAMING_THINKING_ID))
  )
}

function blockText(content: ToolResultBlock['content']): string {
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

function imageRefsOf(content: ToolResultBlock['content'], seq: number): ReadonlyArray<ToolResultImageRef> | undefined {
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

function contentToBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function outputText(output: ToolExecutionOutput): string {
  if (output.type === 'text') {
    return output.value
  }
  try {
    return JSON.stringify(output.value)
  } catch {
    return String(output.value)
  }
}

function slashCommandText(text: string): string | undefined {
  const name = COMMAND_NAME.exec(text)?.[1]?.trim()
  if (!name) {
    return undefined
  }
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

function upsert(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id && existing.kind === item.kind)
  if (index === -1) {
    return [...items, item]
  }
  const next = [...items]
  next[index] = item
  return next
}

export function seedFromSessionInfo(state: TranscriptState, info: SessionInfo): TranscriptState {
  // No event carries the engine — the snapshot is the only source.
  const engine = info.engine ?? state.engine
  return {
    ...state,
    // With held state (reconnect, warm cache seed) the held status stands: any change since is a `status_changed` in the replay span — events stay the one authority.
    status: state.lastSeq === 0 ? info.status : state.status,
    model: state.model ?? info.model,
    permissionMode: state.permissionMode ?? info.permissionMode,
    cwd: state.cwd ?? info.cwd,
    sdkSessionId: state.sdkSessionId ?? info.sdkSessionId,
    engine,
    capabilities: info.capabilities ?? ENGINE_CAPABILITIES[engine ?? 'claude'],
    session: info,
  }
}

export function rateLimitWindows(state: TranscriptState): UsageWindowRow[] {
  return orderUsageWindows(mergeUsage({ rateLimits: state.rateLimits, updatedAt: state.rateLimitsUpdatedAt }, undefined))
}

export function hydrateToolResult(state: TranscriptState, toolUseId: string, text: string): TranscriptState {
  let changed = false
  const items = state.items.map((item) => {
    if (item.kind !== 'tool_call' || item.id !== toolUseId || !item.result?.truncated) {
      return item
    }
    changed = true
    // `images` survives the text hydration: the refs carry their own `sourceSeq` because the result's clears here, and without them the row's pictures are unloadable.
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

export function applyEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  if (event.seq <= state.lastSeq) {
    return state
  }
  const base: TranscriptState = { ...state, lastSeq: event.seq }

  switch (event.type) {
    case 'system_init': {
      return {
        ...base,
        model: event.model,
        cwd: event.cwd,
        sdkSessionId: event.sdkSessionId,
        permissionMode: event.permissionMode,
      }
    }

    case 'status_changed': {
      return { ...base, status: event.status, statusDetail: event.detail }
    }

    case 'capabilities': {
      return {
        ...base,
        models: event.models,
        commands: event.commands,
        defaultModel: event.defaultModel ?? base.defaultModel,
      }
    }

    case 'skills': {
      return { ...base, skills: event.skills }
    }

    case 'file_produced': {
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
    }

    case 'model_changed': {
      return event.model === undefined ? base : { ...base, model: event.model }
    }

    case 'permission_mode_changed': {
      return { ...base, permissionMode: event.mode }
    }

    case 'context_usage': {
      return { ...base, contextUsage: event.usage }
    }

    case 'rate_limit': {
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

    case 'plan_info': {
      return { ...base, subscriptionType: event.subscriptionType }
    }

    case 'conversation_reset': {
      return {
        ...base,
        items: [],
        contextUsage: undefined,
        sdkSessionId: event.sdkSessionId ?? base.sdkSessionId,
      }
    }

    // Deliberately unlike the reset above: it appends rather than empties. `contextUsage` is left
    // alone too — the engine reports the post-compaction occupancy itself, and guessing here would
    // put a number on the ring that no `context_usage` event ever said.
    case 'context_compacted': {
      return {
        ...base,
        items: upsert(base.items, {
          kind: 'compaction',
          id: event.uuid,
          parentToolUseId: event.parentToolUseId ?? null,
        }),
      }
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
                    ...(toolResult.truncated && {
                      truncated: true as const,
                      totalChars: toolResult.total_chars,
                      sourceSeq: event.seq,
                    }),
                    ...(imageRefsOf(toolResult.content, event.seq) && {
                      images: imageRefsOf(toolResult.content, event.seq),
                    }),
                  },
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
              text: slashCommandText(text) ?? text,
              attachments: event.attachments,
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
      const streamingText = streamingTextId(event.parentToolUseId)
      const streamingThought = streamingThinkingId(event.parentToolUseId)
      let streamedThinking =
        base.items.find(
          (item): item is Extract<TranscriptItem, { kind: 'thinking' }> => item.kind === 'thinking' && item.id === streamingThought,
        )?.text ?? ''
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
          streamedThinking = ''
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
        // Whitespace-only (encrypted) thinking creates no item — `turn_result` would finalize a permanent empty row; text rebuilds from `existing`, so skipping loses nothing.
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

    case 'turn_result': {
      return {
        ...base,
        totalCostUsd: event.totalCostUsd,
        items: [
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
    }

    case 'permission_requested': {
      return { ...base, pendingApprovals: [...base.pendingApprovals, event.request] }
    }

    case 'permission_resolved': {
      return {
        ...base,
        pendingApprovals: base.pendingApprovals.filter((r) => r.id !== event.requestId),
      }
    }

    case 'execution_dispatched': {
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
    }

    case 'execution_result': {
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
    }

    case 'execution_failed': {
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
    }

    case 'file_delivered': {
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
    }

    case 'session_error': {
      return {
        ...base,
        items: [...base.items, { kind: 'notice', id: `err-${event.seq}`, level: 'error', text: event.message }],
      }
    }

    case 'session_closed': {
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
    }

    case 'sdk_event':
    default: {
      return base
    }
  }
}
