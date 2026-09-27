import { randomUUID } from 'node:crypto'
import type { LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai'
import { errorMessage, type ContentBlock, type SessionEventBody } from '@workerdeck/protocol'

export type TurnUsage = { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number }

export type WireUsage = {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export type TurnStreamSink = {
  emit(body: SessionEventBody): void
  model(): string | undefined
  partials: boolean
}

export function newTurnUsage(startedAt: number = Date.now()): TurnUsage {
  return { startedAt, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
}

export function addUsage(accum: TurnUsage, usage: LanguageModelUsage): void {
  accum.input += usage.inputTokens ?? 0
  accum.output += usage.outputTokens ?? 0
  accum.cacheWrite += usage.inputTokenDetails?.cacheWriteTokens ?? 0
  accum.cacheRead += usage.inputTokenDetails?.cacheReadTokens ?? 0
}

export function wireUsage(accum: Omit<TurnUsage, 'startedAt'>): WireUsage {
  return {
    input_tokens: accum.input,
    output_tokens: accum.output,
    cache_creation_input_tokens: accum.cacheWrite,
    cache_read_input_tokens: accum.cacheRead,
  }
}

export function settledToolCallIds(responseMessages: readonly ModelMessage[]): Set<string> {
  const settled = new Set<string>()
  for (const message of responseMessages) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      continue
    }
    for (const part of message.content) {
      if (part.type === 'tool-result') {
        settled.add(part.toolCallId)
      }
    }
  }
  return settled
}

export class TurnStream {
  readonly #sink: TurnStreamSink
  #blocks: ContentBlock[] = []
  readonly #text = new Map<string, string>()
  readonly #reasoning = new Map<string, string>()
  #error: unknown

  constructor(sink: TurnStreamSink) {
    this.#sink = sink
  }

  get error(): unknown {
    return this.#error
  }

  accept(part: TextStreamPart<ToolSet>): void {
    switch (part.type) {
      case 'text-delta': {
        this.#text.set(part.id, (this.#text.get(part.id) ?? '') + part.text)
        this.#delta({ type: 'text_delta', text: part.text })
        break
      }
      case 'text-end': {
        this.#hold(this.#text, part.id, (text) => ({ type: 'text', text }))
        break
      }
      case 'reasoning-delta': {
        this.#reasoning.set(part.id, (this.#reasoning.get(part.id) ?? '') + part.text)
        this.#delta({ type: 'thinking_delta', thinking: part.text })
        break
      }
      case 'reasoning-end': {
        this.#hold(this.#reasoning, part.id, (thinking) => ({ type: 'thinking', thinking }))
        break
      }
      case 'tool-call': {
        this.#blocks.push({ type: 'tool_use', id: part.toolCallId, name: part.toolName, input: part.input })
        this.flush()
        break
      }
      case 'tool-result': {
        this.#toolResult(part.toolCallId, typeof part.output === 'string' ? part.output : JSON.stringify(part.output))
        break
      }
      case 'tool-error': {
        this.#toolResult(part.toolCallId, errorMessage(part.error), true)
        break
      }
      case 'finish-step': {
        this.flush()
        break
      }
      case 'error': {
        this.#error ??= part.error
        break
      }
      default: {
        break
      }
    }
  }

  flush(): void {
    if (this.#blocks.length === 0) {
      return
    }
    this.#sink.emit({
      type: 'assistant_message',
      message: { role: 'assistant', content: this.#blocks, model: this.#sink.model() },
      parentToolUseId: null,
      uuid: randomUUID(),
    })
    this.#blocks = []
  }

  flushPartial(): void {
    for (const thinking of this.#reasoning.values()) {
      if (thinking) {
        this.#blocks.push({ type: 'thinking', thinking })
      }
    }
    for (const text of this.#text.values()) {
      if (text) {
        this.#blocks.push({ type: 'text', text })
      }
    }
    this.flush()
  }

  #hold(buffer: Map<string, string>, id: string, block: (value: string) => ContentBlock): void {
    const value = buffer.get(id)
    buffer.delete(id)
    if (value) {
      this.#blocks.push(block(value))
    }
  }

  #delta(delta: { type: 'text_delta'; text: string } | { type: 'thinking_delta'; thinking: string }): void {
    if (!this.#sink.partials) {
      return
    }
    this.#sink.emit({ type: 'stream_delta', event: { type: 'content_block_delta', delta }, parentToolUseId: null, uuid: randomUUID() })
  }

  #toolResult(toolCallId: string, content: string, isError?: boolean): void {
    this.flush()
    this.#sink.emit({
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content, is_error: isError }] },
      parentToolUseId: null,
      synthetic: true,
      uuid: randomUUID(),
    })
  }
}
