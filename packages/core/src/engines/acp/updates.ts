import { randomUUID } from 'node:crypto'
import type { ChecklistItem, ContentBlock, FilePatch, SessionEventBody } from '@workerdeck/protocol'
import { checklistFromPlan } from '../../lib/checklist.ts'
import { filePatchFromTexts } from '../../lib/patch.ts'
import type { AcpCommand, AcpConfigOption, AcpContentBlock, AcpPlanEntry, AcpSessionUpdate, AcpToolCall } from './types.ts'

export type AcpSink = {
  emit(body: SessionEventBody): void
  model(): string | undefined
  partials(): boolean
  title(title: string): void
  commands(commands: AcpCommand[]): void
  configOptions(options: AcpConfigOption[]): void
  mode(modeId: string): void
  context(used: number, size: number): void
  checklist(items: ChecklistItem[]): void
}

type ToolState = AcpToolCall & { emitted: boolean; settled: boolean }

const TOOL_RESULT_MAX_CHARS = 64_000

function blockText(block: AcpContentBlock | undefined): string {
  if (!block) {
    return ''
  }
  if (block.type === 'text') {
    return block.text
  }
  if (block.type === 'resource') {
    return block.resource.text ?? block.resource.uri
  }
  return '[image]'
}

function toolInput(call: AcpToolCall): Record<string, unknown> {
  const raw = call.rawInput ?? (call as { args?: unknown }).args
  const input = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}
  if (call.title && input.title === undefined) {
    input.title = call.title
  }
  return input
}

function toolResultText(call: AcpToolCall): string {
  const raw = call.rawOutput as { output?: unknown; error?: unknown } | string | undefined | null
  if (typeof raw === 'string' && raw) {
    return raw
  }
  if (raw && typeof raw === 'object') {
    if (typeof raw.output === 'string' && raw.output) {
      return raw.output
    }
    if (typeof raw.error === 'string' && raw.error) {
      return raw.error
    }
  }
  const parts: string[] = []
  for (const item of call.content ?? []) {
    if (item.type === 'content') {
      parts.push(blockText(item.content))
    } else if (item.type === 'diff') {
      parts.push(`${item.oldText === null || item.oldText === undefined ? 'Created' : 'Edited'} ${item.path}`)
    }
  }
  const text = parts.filter(Boolean).join('\n')
  if (text) {
    return text
  }
  return call.status === 'failed' ? 'failed' : ''
}

function toolPatch(call: AcpToolCall): FilePatch | undefined {
  const diff = call.content?.find((item) => item.type === 'diff')
  return diff?.type === 'diff' ? filePatchFromTexts(diff.path, diff.oldText, diff.newText) : undefined
}

function planItems(entries: AcpPlanEntry[]): ChecklistItem[] | undefined {
  return checklistFromPlan(entries.map((entry) => ({ step: entry.content, status: entry.status })))
}

// Turns ACP `session/update`s into the session's events. Text and thinking stream as deltas and land as one
// assistant message at each tool call and at turn end: agy's chunks carry no message id.
export class AcpTranscript {
  readonly #sink: AcpSink
  #nonce = 'acp'
  #text = ''
  #thinking = ''
  #user = ''
  #lastText: string | undefined
  #tools = new Map<string, ToolState>()
  #replaying = false

  constructor(sink: AcpSink) {
    this.#sink = sink
  }

  beginTurn(nonce: string): void {
    this.flush()
    this.#nonce = nonce
    this.#lastText = undefined
    this.#tools.clear()
  }

  setReplaying(replaying: boolean): void {
    this.flush()
    this.#replaying = replaying
  }

  get lastText(): string | undefined {
    return this.#lastText
  }

  toolUseId(toolCallId: string): string {
    return `${this.#nonce}:${toolCallId}`
  }

  apply(update: AcpSessionUpdate): void {
    if (update.sessionUpdate !== 'user_message_chunk') {
      this.#flushUser()
    }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        this.#appendText(blockText(update.content))
        return
      }
      case 'agent_thought_chunk': {
        this.#appendThinking(blockText(update.content))
        return
      }
      case 'user_message_chunk': {
        if (this.#replaying) {
          this.flush()
          this.#user += blockText(update.content)
        }
        return
      }
      case 'tool_call':
      case 'tool_call_update': {
        this.#tool(update)
        return
      }
      case 'plan': {
        const items = planItems(update.entries)
        if (items) {
          this.#sink.checklist(items)
        }
        return
      }
      case 'available_commands_update': {
        this.#sink.commands(update.availableCommands)
        return
      }
      case 'config_option_update': {
        this.#sink.configOptions(update.configOptions)
        return
      }
      case 'current_mode_update': {
        this.#sink.mode(update.currentModeId)
        return
      }
      case 'session_info_update': {
        if (typeof update.title === 'string' && update.title) {
          this.#sink.title(update.title)
        }
        return
      }
      case 'usage_update': {
        this.#sink.context(update.used, update.size)
        return
      }
      default: {
        const unknown = update as { sessionUpdate?: unknown }
        this.#sink.emit({ type: 'sdk_event', payload: { type: `acp.${String(unknown.sessionUpdate)}`, update } })
      }
    }
  }

  flush(): void {
    this.#flushUser()
    const content: ContentBlock[] = []
    if (this.#thinking) {
      content.push({ type: 'thinking', thinking: this.#thinking })
    }
    if (this.#text) {
      content.push({ type: 'text', text: this.#text })
      this.#lastText = this.#text
    }
    this.#thinking = ''
    this.#text = ''
    if (content.length > 0) {
      this.#emitAssistant(content, randomUUID())
    }
  }

  // Tool calls still open when a turn ends (cancelled, failed) settle as errors so no card spins forever.
  settleOpenTools(reason: string): void {
    for (const state of this.#tools.values()) {
      if (state.emitted && !state.settled) {
        state.settled = true
        this.#emitToolResult(state, reason, true)
      }
    }
  }

  #appendText(text: string): void {
    if (!text) {
      return
    }
    if (this.#thinking && !this.#text) {
      this.#flushThinkingOnly()
    }
    this.#text += text
    this.#delta({ type: 'text_delta', text })
  }

  #appendThinking(thinking: string): void {
    if (!thinking) {
      return
    }
    if (this.#text) {
      this.flush()
    }
    this.#thinking += thinking
    this.#delta({ type: 'thinking_delta', thinking })
  }

  #flushThinkingOnly(): void {
    const thinking = this.#thinking
    this.#thinking = ''
    this.#emitAssistant([{ type: 'thinking', thinking }], randomUUID())
  }

  #flushUser(): void {
    if (!this.#user) {
      return
    }
    const text = this.#user
    this.#user = ''
    this.#sink.emit({ type: 'user_message', message: { role: 'user', content: text }, parentToolUseId: null, uuid: randomUUID() })
  }

  #delta(delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }): void {
    if (this.#replaying || !this.#sink.partials()) {
      return
    }
    this.#sink.emit({ type: 'stream_delta', event: { type: 'content_block_delta', delta }, parentToolUseId: null, uuid: randomUUID() })
  }

  #tool(update: AcpToolCall): void {
    const known = this.#tools.get(update.toolCallId)
    const state: ToolState = known
      ? { ...known, ...definedFields(update), emitted: known.emitted, settled: known.settled }
      : { ...update, emitted: false, settled: false }
    this.#tools.set(update.toolCallId, state)
    if (!state.emitted) {
      this.flush()
      state.emitted = true
      this.#sink.emit({
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: this.toolUseId(state.toolCallId), name: toolName(state), input: toolInput(state) }],
          model: this.#sink.model(),
        },
        parentToolUseId: null,
        uuid: `${this.toolUseId(state.toolCallId)}-use`,
      })
    }
    if (!state.settled && (state.status === 'completed' || state.status === 'failed')) {
      state.settled = true
      this.#emitToolResult(state, toolResultText(state), state.status === 'failed', toolPatch(state))
    }
  }

  #emitToolResult(state: ToolState, text: string, isError: boolean, patch?: FilePatch): void {
    const toolUseId = this.toolUseId(state.toolCallId)
    this.#sink.emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: text.slice(0, TOOL_RESULT_MAX_CHARS), is_error: isError || undefined },
        ],
      },
      parentToolUseId: null,
      synthetic: true,
      patch,
      uuid: `${toolUseId}-result`,
    })
  }

  #emitAssistant(content: ContentBlock[], uuid: string): void {
    this.#sink.emit({
      type: 'assistant_message',
      message: { role: 'assistant', content, model: this.#sink.model() },
      parentToolUseId: null,
      uuid,
    })
  }
}

export function toolName(call: AcpToolCall): string {
  if (call.name) {
    return call.name
  }
  return call.kind ? `acp_${call.kind}` : 'acp_tool'
}

function definedFields(update: AcpToolCall): Partial<AcpToolCall> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined && value !== null) {
      out[key] = value
    }
  }
  return out as Partial<AcpToolCall>
}
