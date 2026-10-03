import type { SessionEventBody } from '@workerdeck/protocol'
import { ttyText } from './tty-text.ts'

export const TOOL_OUTPUT_FLUSH_MS = 400
export const TOOL_OUTPUT_TAIL_LINES = 12
export const TOOL_OUTPUT_TAIL_CHARS = 2000
const RAW_KEEP = 16_384

type Tail = { raw: string; sent: string; timer?: ReturnType<typeof setTimeout>; stop?: () => void }

export function toolOutputTail(raw: string): string {
  const lines = ttyText(raw).replace(/\n+$/, '').split('\n')
  const kept = lines.slice(-TOOL_OUTPUT_TAIL_LINES).join('\n')
  return kept.length > TOOL_OUTPUT_TAIL_CHARS ? kept.slice(-TOOL_OUTPUT_TAIL_CHARS) : kept
}

// The live tail of a running tool's output, flushed at most every TOOL_OUTPUT_FLUSH_MS per tool as a whole tail
// (never a delta), so a client that attaches mid-run needs only the latest event.
export class ToolOutputTails {
  #tails = new Map<string, Tail>()
  readonly #emit: (body: SessionEventBody) => void
  readonly #flushMs: number

  constructor(emit: (body: SessionEventBody) => void, flushMs = TOOL_OUTPUT_FLUSH_MS) {
    this.#emit = emit
    this.#flushMs = flushMs
  }

  has(toolUseId: string): boolean {
    return this.#tails.has(toolUseId)
  }

  track(toolUseId: string, stop: () => void): void {
    this.#tailFor(toolUseId).stop = stop
  }

  append(toolUseId: string, chunk: string): void {
    if (chunk === '') {
      return
    }
    const tail = this.#tailFor(toolUseId)
    tail.raw = (tail.raw + chunk).slice(-RAW_KEEP)
    tail.timer ??= setTimeout(() => this.#flush(toolUseId), this.#flushMs)
    tail.timer.unref?.()
  }

  end(toolUseId: string): void {
    const tail = this.#tails.get(toolUseId)
    if (!tail) {
      return
    }
    this.#tails.delete(toolUseId)
    clearTimeout(tail.timer)
    tail.stop?.()
  }

  clear(): void {
    for (const toolUseId of this.#tails.keys()) {
      this.end(toolUseId)
    }
  }

  observe(body: SessionEventBody): void {
    switch (body.type) {
      case 'user_message': {
        if (typeof body.message.content === 'string') {
          return
        }
        for (const block of body.message.content) {
          const id = (block as { type?: unknown; tool_use_id?: unknown }).tool_use_id
          if (block.type === 'tool_result' && typeof id === 'string') {
            this.end(id)
          }
        }
        return
      }
      case 'turn_result':
      case 'conversation_reset':
      case 'session_closed': {
        this.clear()
        return
      }
      case 'status_changed': {
        if (body.status !== 'running' && body.status !== 'awaiting_approval') {
          this.clear()
        }
        return
      }
      default: {
        return
      }
    }
  }

  #tailFor(toolUseId: string): Tail {
    let tail = this.#tails.get(toolUseId)
    if (!tail) {
      tail = { raw: '', sent: '' }
      this.#tails.set(toolUseId, tail)
    }
    return tail
  }

  #flush(toolUseId: string): void {
    const tail = this.#tails.get(toolUseId)
    if (!tail) {
      return
    }
    tail.timer = undefined
    const text = toolOutputTail(tail.raw)
    if (text === tail.sent || text.trim() === '') {
      return
    }
    tail.sent = text
    this.#emit({ type: 'tool_output', toolUseId, tail: text })
  }
}
