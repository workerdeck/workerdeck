import { createHash, randomUUID } from 'node:crypto'
import type { ContentBlock, FilePatch, SessionEventBody } from '@workerdeck/protocol'
import { parseUnifiedDiff } from '../../lib/patch.ts'
import type { CodexAgent, CodexAgentTracker, ItemScope } from './subagents.ts'
import type {
  AppServerCollabAgentToolCallItem,
  AppServerImageGenerationItem,
  AppServerItem,
  AppServerTurn,
  AppServerUnknownItem,
  AppServerUserMessageItem,
} from './types.ts'

export type ItemSink = {
  agents: CodexAgentTracker
  model(): string | undefined
  rootThreadId(): string | undefined
  replaying(): boolean
  partials(): boolean
  emit(body: SessionEventBody): void
  fileProduced(path: string, toolUseId: string): void
  finalText(text: string): void
}

export type ItemRouting = {
  activeScope: ItemScope | undefined
  idleScope: ItemScope
  clearedThreads: ReadonlySet<string>
}

export type ItemContext = { scope: ItemScope; agent?: CodexAgent }

export type StreamDelta = { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }

type CompletedHandler<K extends AppServerItem['type']> = (
  sink: ItemSink,
  item: Extract<AppServerItem, { type: K }>,
  scope: ItemScope,
  id: string,
  agent?: CodexAgent,
) => void

export const CODEX_IMAGE_TOOL = 'CodexImageGeneration'

export const CODEX_AGENT_TOOL = 'CodexAgent'

export const CODEX_COLLAB_TOOL = 'CodexCollab'

const MAX_IMAGE_RESULT_CHARS = 512

const PRODUCED_MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

const ITEM_COMPLETED: { [K in AppServerItem['type']]: CompletedHandler<K> } = {
  userMessage: (sink, item, scope, _id, agent) => {
    if (!agent) {
      return
    }
    const text = historyUserText(item)
    if (!text) {
      return
    }
    sink.emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: agent.toolUseId,
      uuid: `${scope.nonce}:${item.id}`,
    })
  },
  agentMessage: (sink, item, _scope, id, agent) => {
    const text = typeof item.text === 'string' ? item.text : ''
    emitAssistant(sink, id, [{ type: 'text', text }], agent?.toolUseId ?? null)
    if (!agent) {
      sink.finalText(text)
    }
  },
  reasoning: (sink, item, _scope, id, agent) => {
    const summary = Array.isArray(item.summary) ? item.summary.filter(Boolean) : []
    const content = Array.isArray(item.content) ? item.content.filter(Boolean) : []
    const thinking = (summary.length > 0 ? summary : content).join('\n\n')
    if (thinking) {
      emitAssistant(sink, id, [{ type: 'thinking', thinking }], agent?.toolUseId ?? null)
    }
  },
  commandExecution: (sink, item, scope, id, agent) => {
    emitToolUseOnce(sink, scope, id, 'CodexCommand', { command: item.command }, agent)
    const exitCode = item.exitCode ?? undefined
    const failed = item.status === 'failed' || item.status === 'declined' || (exitCode !== undefined && exitCode !== 0)
    const output = (item.aggregatedOutput ?? '') + (exitCode !== undefined && exitCode !== 0 ? `\n(exit code ${exitCode})` : '')
    emitToolResult(sink, id, output, failed, undefined, agent?.toolUseId ?? null)
  },
  fileChange: (sink, item, _scope, id, agent) => {
    emitToolUse(sink, id, 'CodexFileChange', { changes: item.changes }, agent)
    const lines = item.changes.map((change) => {
      const kind = typeof change.kind === 'string' ? change.kind : change.kind?.type
      return `${kind ?? 'change'}: ${change.path}`
    })
    // A patch names one file, and a multi-file edit has no honest way to say which.
    const only = item.changes.length === 1 ? item.changes[0] : undefined
    emitToolResult(
      sink,
      id,
      lines.join('\n') || item.status,
      item.status === 'failed' || item.status === 'declined',
      only?.diff ? parseUnifiedDiff(only.diff, only.path) : undefined,
      agent?.toolUseId ?? null,
    )
  },
  mcpToolCall: (sink, item, scope, id, agent) => {
    emitToolUseOnce(sink, scope, id, `mcp__${item.server}__${item.tool}`, item.arguments, agent)
    const isError = (item.error !== undefined && item.error !== null) || item.status === 'failed'
    const content = item.error?.message ?? (item.result === undefined || item.result === null ? '' : JSON.stringify(item.result))
    emitToolResult(sink, id, content, isError, undefined, agent?.toolUseId ?? null)
  },
  dynamicToolCall: (sink, item, scope, id, agent) => {
    emitToolUseOnce(sink, scope, id, item.tool, item.arguments, agent)
    const text = (item.contentItems ?? [])
      .map((part) => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
    emitToolResult(sink, id, text, item.success === false || item.status === 'failed', undefined, agent?.toolUseId ?? null)
  },
  webSearch: (sink, item, _scope, id, agent) => {
    emitToolUse(sink, id, 'CodexWebSearch', { query: item.query }, agent)
    emitToolResult(sink, id, '', false, undefined, agent?.toolUseId ?? null)
  },
  imageGeneration: (sink, item, scope, id, agent) => {
    // Re-emitted without the `toolUseEmitted` guard: `savedPath` only exists now, and the
    // reducer upserts a tool_use by id, so this replaces the in-progress card's input.
    scope.toolUseEmitted.add(id)
    emitToolUse(sink, id, CODEX_IMAGE_TOOL, imageGenerationInput(item), agent)
    if (item.savedPath) {
      sink.fileProduced(item.savedPath, id)
    }
    const lines = [
      item.savedPath ? `Saved to ${item.savedPath}` : 'No saved path reported',
      ...(shortResult(item.result) ? [item.result] : []),
    ]
    emitToolResult(sink, id, lines.join('\n'), item.status === 'failed', undefined, agent?.toolUseId ?? null)
  },
  imageView: (sink, item, _scope, id, agent) => {
    emitToolUse(sink, id, 'CodexImageView', { path: item.path }, agent)
    emitToolResult(sink, id, item.path, false, undefined, agent?.toolUseId ?? null)
  },
  contextCompaction: (sink, _item, _scope, id, agent) => {
    sink.emit({ type: 'context_compacted', uuid: id, parentToolUseId: agent?.toolUseId ?? null })
  },
  subAgentActivity: (sink, item, _scope, id, agent) => {
    // Codex names the counterpart of an interaction, and the counterpart of a sub-agent's message
    // back is this session's own thread (`agentPath: '/root'`). It is not an agent of itself.
    if (item.agentThreadId === sink.rootThreadId()) {
      return
    }
    if (sink.replaying()) {
      if (item.kind !== 'started') {
        return
      }
      emitToolUse(sink, id, CODEX_AGENT_TOOL, agentInput(agentName(item.agentPath), item.agentThreadId, item.agentPath), agent)
      // A resumed thread's history holds the root's items only, so a replayed agent row closes
      // neutrally: the one claim history cannot back is that the agent failed.
      emitToolResult(
        sink,
        id,
        "(ran in its own thread, so its work is not part of this thread's stored history)",
        false,
        undefined,
        agent?.toolUseId ?? null,
      )
      return
    }
    const record = sink.agents.get(item.agentThreadId) ?? sink.agents.open(item.agentThreadId, id, undefined, Date.now())
    const name = agentName(item.agentPath)
    const relabel = record.agentType === undefined && name !== undefined
    if (relabel) {
      record.agentType = name
    }
    if (!record.anchored || relabel) {
      record.anchored = true
      emitToolUse(sink, record.toolUseId, CODEX_AGENT_TOOL, agentInput(record.agentType, item.agentThreadId, item.agentPath), agent)
    }
    if (item.kind === 'interrupted') {
      if (record.status === 'running') {
        sink.agents.settle(record, 'failed')
        emitToolResult(sink, record.toolUseId, 'interrupted', true)
      }
      return
    }
    // The agent thread's own turn/completed is the richer signal and settles first when it
    // arrives, but it is not guaranteed to reach a thread we never subscribed to.
    if (item.kind === 'completed') {
      if (record.status === 'running') {
        sink.agents.settle(record, 'done')
        emitToolResult(sink, record.toolUseId, '', false)
      }
      return
    }
    if (item.kind !== 'started' && record.status !== 'running') {
      sink.agents.revive(record)
    }
  },
  collabAgentToolCall: (sink, item, scope, id, agent) => {
    emitToolUseOnce(sink, scope, id, CODEX_COLLAB_TOOL, collabInput(item), agent)
    if (item.status === 'inProgress') {
      return
    }
    const failed = item.status === 'failed' || item.status === 'declined'
    emitToolResult(sink, id, failed ? item.status : '', failed, undefined, agent?.toolUseId ?? null)
  },
}

export function itemCompleted(sink: ItemSink, item: AppServerItem, scope: ItemScope, agent?: CodexAgent): void {
  const id = `${scope.nonce}:${item.id}`
  const handler = ITEM_COMPLETED[item.type] as CompletedHandler<AppServerItem['type']> | undefined
  if (handler) {
    handler(sink, item, scope, id, agent)
    return
  }
  const unknown = item as AppServerUnknownItem
  sink.emit({ type: 'sdk_event', payload: { type: `codex.${unknown.type}`, item: unknown } })
}

export function itemProgress(sink: ItemSink, item: AppServerItem, scope: ItemScope, agent?: CodexAgent): void {
  const id = `${scope.nonce}:${item.id}`
  if (item.type === 'subAgentActivity') {
    ITEM_COMPLETED.subAgentActivity(sink, item, scope, id, agent)
    return
  }
  if (scope.toolUseEmitted.has(id)) {
    return
  }
  switch (item.type) {
    case 'commandExecution': {
      emitToolUseOnce(sink, scope, id, 'CodexCommand', { command: item.command }, agent)
      return
    }
    case 'mcpToolCall': {
      emitToolUseOnce(sink, scope, id, `mcp__${item.server}__${item.tool}`, item.arguments, agent)
      return
    }
    case 'dynamicToolCall': {
      emitToolUseOnce(sink, scope, id, item.tool, item.arguments, agent)
      return
    }
    case 'contextCompaction': {
      // Reuses the tool-use ledger only as a once-per-item latch; the row it draws is the
      // compaction boundary, which `item/completed` then settles under the same id.
      scope.toolUseEmitted.add(id)
      sink.emit({ type: 'context_compacted', uuid: id, pending: true, parentToolUseId: agent?.toolUseId ?? null })
      return
    }
    case 'collabAgentToolCall': {
      emitToolUseOnce(sink, scope, id, CODEX_COLLAB_TOOL, collabInput(item), agent)
      return
    }
    case 'imageGeneration': {
      emitToolUseOnce(sink, scope, id, CODEX_IMAGE_TOOL, imageGenerationInput(item), agent)
      if (item.savedPath) {
        sink.fileProduced(item.savedPath, id)
      }
      return
    }
    default: {
      return
    }
  }
}

// A child's items resolve through the agent's own scope, so they survive the root turn ending
// while the agent works. On the root thread the scope is the live turn; between turns only a
// subAgentActivity item is heard, because a settle or a relabel is the one thing codex can still
// say about an agent it spawned earlier.
export function itemContext(sink: ItemSink, params: unknown, routing: ItemRouting): ItemContext | undefined {
  const agent = agentFor(sink, params, routing)
  if (agent) {
    return { scope: agent.scope, agent }
  }
  if (routing.activeScope) {
    return { scope: routing.activeScope }
  }
  const item = (params as { item?: AppServerItem })?.item
  if (item?.type === 'subAgentActivity') {
    return { scope: routing.idleScope }
  }
  return undefined
}

export function threadIdOf(params: unknown): string | undefined {
  const threadId = (params as { threadId?: unknown })?.threadId
  return typeof threadId === 'string' ? threadId : undefined
}

export function settleAgentTurn(sink: ItemSink, params: unknown): void {
  const threadId = threadIdOf(params)
  const record = threadId ? sink.agents.get(threadId) : undefined
  if (!record || record.status !== 'running') {
    return
  }
  const turn = (params as { turn?: AppServerTurn })?.turn
  const status = turn?.status === 'completed' ? 'done' : 'failed'
  sink.agents.settle(record, status)
  const report = (turn ? turnReport(turn) : undefined) ?? turn?.error?.message ?? (status === 'done' ? '' : (turn?.status ?? 'failed'))
  emitToolResult(sink, record.toolUseId, report, status === 'failed')
}

export function reasoningDelta(sink: ItemSink, method: string, params: unknown, context: ItemContext): void {
  const payload = params as { delta?: string; itemId?: string; contentIndex?: number; summaryIndex?: number }
  if (typeof payload?.delta !== 'string' || !payload.delta) {
    return
  }
  const index = payload.contentIndex ?? payload.summaryIndex ?? 0
  const key = `${payload.itemId ?? ''}:${method}`
  const previous = context.scope.sectionIndex.get(key)
  context.scope.sectionIndex.set(key, index)
  const separator = previous !== undefined && index > previous ? '\n\n' : ''
  emitDelta(sink, { type: 'thinking_delta', thinking: separator + payload.delta }, context.agent?.toolUseId ?? null)
}

export function emitDelta(sink: ItemSink, delta: StreamDelta, parent: string | null): void {
  if (!sink.partials()) {
    return
  }
  sink.emit({ type: 'stream_delta', event: { type: 'content_block_delta', delta }, parentToolUseId: parent, uuid: randomUUID() })
}

export function emitToolUse(sink: ItemSink, id: string, name: string, input: unknown, agent?: CodexAgent): void {
  if (agent && !agent.counted.has(id)) {
    agent.counted.add(id)
    agent.toolCount += 1
  }
  sink.emit({
    type: 'assistant_message',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }], model: sink.model() },
    parentToolUseId: agent?.toolUseId ?? null,
    uuid: `${id}-use`,
  })
}

export function emitToolResult(
  sink: ItemSink,
  toolUseId: string,
  content: string,
  isError: boolean,
  patch?: FilePatch,
  parent: string | null = null,
): void {
  sink.emit({
    type: 'user_message',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError || undefined }] },
    parentToolUseId: parent,
    synthetic: true,
    patch,
    uuid: `${toolUseId}-result`,
  })
}

export function historyUserText(item: AppServerUserMessageItem): string {
  if (!Array.isArray(item.content)) {
    return ''
  }
  let images = 0
  const text = item.content
    .map((part) => {
      const candidate = part as { type?: string; text?: unknown } | null
      if (candidate?.type === 'text' && typeof candidate.text === 'string') {
        return candidate.text
      }
      if (typeof candidate?.type === 'string' && candidate.type.toLowerCase().includes('image')) {
        images += 1
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
  if (text) {
    return text
  }
  return images > 0 ? `[${images === 1 ? 'image' : `${images} images`}]` : ''
}

export function fileProducedEvent(path: string, toolUseId: string, bytes: number | undefined): SessionEventBody {
  const mediaType = PRODUCED_MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
  return {
    type: 'file_produced',
    fileId: createHash('sha256').update(path).digest('hex').slice(0, 32),
    path,
    ...(mediaType ? { mediaType } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    toolUseId,
  }
}

function agentFor(sink: ItemSink, params: unknown, routing: ItemRouting): CodexAgent | undefined {
  const threadId = threadIdOf(params)
  if (threadId === undefined || threadId === sink.rootThreadId()) {
    return undefined
  }
  const known = sink.agents.get(threadId)
  if (known) {
    return known
  }
  if (routing.clearedThreads.has(threadId)) {
    return undefined
  }
  const nonce = routing.activeScope?.nonce ?? 'codex'
  const record = sink.agents.open(threadId, `${nonce}:agent:${threadId}`, undefined, Date.now())
  record.anchored = true
  emitToolUse(sink, record.toolUseId, CODEX_AGENT_TOOL, { agentThreadId: threadId })
  return record
}

function emitToolUseOnce(sink: ItemSink, scope: ItemScope, id: string, name: string, input: unknown, agent?: CodexAgent): void {
  if (scope.toolUseEmitted.has(id)) {
    return
  }
  scope.toolUseEmitted.add(id)
  emitToolUse(sink, id, name, input, agent)
}

function emitAssistant(sink: ItemSink, uuid: string, content: ContentBlock[], parent: string | null): void {
  sink.emit({ type: 'assistant_message', message: { role: 'assistant', content, model: sink.model() }, parentToolUseId: parent, uuid })
}

function agentInput(agentType: string | undefined, agentThreadId: string, agentPath: string | null | undefined): Record<string, unknown> {
  return {
    ...(agentType ? { subagent_type: agentType } : {}),
    agentThreadId,
    ...(agentPath ? { agentPath } : {}),
  }
}

function agentName(agentPath: string | null | undefined): string | undefined {
  if (typeof agentPath !== 'string') {
    return undefined
  }
  const name = agentPath.split('/').filter(Boolean).at(-1)
  return name || undefined
}

function collabInput(item: AppServerCollabAgentToolCallItem): Record<string, unknown> {
  return {
    tool: item.tool,
    ...(item.receiverThreadIds?.length ? { receiverThreadIds: item.receiverThreadIds } : {}),
    ...(item.prompt ? { prompt: item.prompt } : {}),
    ...(item.model ? { model: item.model } : {}),
  }
}

function imageGenerationInput(item: AppServerImageGenerationItem): Record<string, unknown> {
  return {
    ...(item.revisedPrompt ? { prompt: item.revisedPrompt } : {}),
    ...(item.savedPath ? { savedPath: item.savedPath } : {}),
  }
}

function shortResult(result: string): boolean {
  return result.length > 0 && result.length <= MAX_IMAGE_RESULT_CHARS && !result.startsWith('data:')
}

function turnReport(turn: AppServerTurn): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : []
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
      return item.text
    }
  }
  return undefined
}
