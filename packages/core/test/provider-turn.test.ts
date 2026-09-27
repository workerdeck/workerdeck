import { describe, expect, it } from 'vitest'
import type { LanguageModelUsage, ModelMessage, TextStreamPart, ToolSet } from 'ai'
import type { SessionEventBody } from '@workerdeck/protocol'
import { TurnStream, addUsage, newTurnUsage, settledToolCallIds, wireUsage } from '../src/engines/provider/turn.ts'

type Part = TextStreamPart<ToolSet>

function harness(partials = true) {
  const events: SessionEventBody[] = []
  const stream = new TurnStream({ emit: (body) => events.push(body), model: () => 'mock-1', partials })
  const feed = (...parts: unknown[]) => {
    for (const part of parts) {
      stream.accept(part as Part)
    }
  }
  return { events, stream, feed }
}

function content(body: SessionEventBody | undefined): unknown {
  return (body as { message: { content: unknown } }).message.content
}

describe('TurnStream', () => {
  it('streams deltas live and holds finished blocks until the step ends', () => {
    const { events, feed } = harness()
    feed(
      { type: 'reasoning-delta', id: 'r', text: 'hm' },
      { type: 'reasoning-end', id: 'r' },
      { type: 'text-delta', id: 't', text: 'hel' },
      { type: 'text-delta', id: 't', text: 'lo' },
      { type: 'text-end', id: 't' },
    )
    expect(events.map((e) => e.type)).toEqual(['stream_delta', 'stream_delta', 'stream_delta'])
    feed({ type: 'finish-step' })
    expect(events.at(-1)).toMatchObject({
      type: 'assistant_message',
      parentToolUseId: null,
      message: {
        role: 'assistant',
        model: 'mock-1',
        content: [
          { type: 'thinking', thinking: 'hm' },
          { type: 'text', text: 'hello' },
        ],
      },
    })
  })

  it('suppresses deltas when partial messages are off', () => {
    const { events, feed } = harness(false)
    feed({ type: 'text-delta', id: 't', text: 'x' }, { type: 'text-end', id: 't' }, { type: 'finish-step' })
    expect(events.map((e) => e.type)).toEqual(['assistant_message'])
  })

  it('flushes a tool call as its own message and reports in-loop results as synthetic tool results', () => {
    const { events, feed } = harness(false)
    feed(
      { type: 'text-delta', id: 't', text: 'looking' },
      { type: 'text-end', id: 't' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: { key: 'k' } },
      { type: 'tool-result', toolCallId: 'c1', output: { value: 1 } },
      { type: 'tool-error', toolCallId: 'c2', error: new Error('boom') },
    )
    expect(content(events[0])).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'c1', name: 'lookup', input: { key: 'k' } },
    ])
    expect(events[1]).toMatchObject({ synthetic: true, message: { content: [{ tool_use_id: 'c1', content: '{"value":1}' }] } })
    expect(events[2]).toMatchObject({ message: { content: [{ tool_use_id: 'c2', content: 'boom', is_error: true }] } })
  })

  it('keeps the first stream error only', () => {
    const { stream, feed } = harness()
    feed({ type: 'error', error: 'first' }, { type: 'error', error: 'second' })
    expect(stream.error).toBe('first')
  })

  it('flushes unfinished reasoning and text on an interrupted turn, reasoning first', () => {
    const { events, stream, feed } = harness(false)
    feed({ type: 'text-delta', id: 't', text: 'partial' }, { type: 'reasoning-delta', id: 'r', text: 'thinking' })
    stream.flushPartial()
    expect(content(events[0])).toEqual([
      { type: 'thinking', thinking: 'thinking' },
      { type: 'text', text: 'partial' },
    ])
  })
})

describe('turn usage', () => {
  it('accumulates usage across calls and renders the wire shape', () => {
    const accum = newTurnUsage(0)
    const usage = { inputTokens: 10, outputTokens: 5, inputTokenDetails: { cacheWriteTokens: 2, cacheReadTokens: 3 } } as LanguageModelUsage
    addUsage(accum, usage)
    addUsage(accum, { inputTokens: 1 } as LanguageModelUsage)
    expect(wireUsage(accum)).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    })
  })

  it('names the tool calls the loop already answered', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 't', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 't', output: { type: 'text', value: '' } }] },
    ] as ModelMessage[]
    expect([...settledToolCallIds(messages)]).toEqual(['a'])
  })
})
