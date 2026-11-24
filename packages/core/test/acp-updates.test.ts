import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChecklistItem, SessionEventBody } from '@workerdeck/protocol'
import { AcpTranscript, type AcpSink } from '../src/engines/acp/updates.ts'
import type { AcpSessionUpdate } from '../src/engines/acp/types.ts'
import { filePatchFromTexts } from '../src/lib/patch.ts'

type Recorded = AcpSink & { events: SessionEventBody[]; titles: string[]; contexts: number[]; checklists: ChecklistItem[][] }

function sink(partials = true): Recorded {
  const events: SessionEventBody[] = []
  const titles: string[] = []
  const contexts: number[] = []
  const checklists: ChecklistItem[][] = []
  return {
    events,
    titles,
    contexts,
    checklists,
    emit: (body) => events.push(body),
    model: () => 'gemini-test',
    partials: () => partials,
    title: (title) => titles.push(title),
    commands: () => {},
    configOptions: () => {},
    mode: () => {},
    context: (used) => contexts.push(used),
    checklist: (items) => checklists.push(items),
  }
}

function fixtureUpdates(name: string): AcpSessionUpdate[] {
  return readFileSync(new URL(`./fixtures/acp/agy-1.5.16/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('<< '))
    .map((line) => JSON.parse(line.slice(3)) as { method?: string; params?: { update?: AcpSessionUpdate } })
    .filter((message) => message.method === 'session/update' && message.params?.update)
    .map((message) => message.params!.update!)
}

function kinds(events: SessionEventBody[]): string[] {
  return events
    .filter((event) => event.type !== 'stream_delta')
    .map((event) => {
      if (event.type === 'assistant_message') {
        return `assistant:${event.message.content.map((block) => block.type).join('+')}`
      }
      if (event.type === 'user_message') {
        return Array.isArray(event.message.content) ? `user:${event.message.content.map((block) => block.type).join('+')}` : 'user:text'
      }
      return event.type
    })
}

describe('AcpTranscript', () => {
  it('maps a recorded agy tool turn to tool cards with results and a final text', () => {
    const recorded = sink()
    const transcript = new AcpTranscript(recorded)
    transcript.beginTurn('turn-1')
    for (const update of fixtureUpdates('tool-turn.ndjson')) {
      transcript.apply(update)
    }
    transcript.flush()
    expect(kinds(recorded.events)).toEqual([
      'assistant:thinking',
      'assistant:text',
      'assistant:tool_use',
      'user:tool_result',
      'assistant:tool_use',
      'user:tool_result',
      'assistant:text',
    ])
    const uses = recorded.events
      .flatMap((event) => (event.type === 'assistant_message' ? event.message.content : []))
      .filter((block) => block.type === 'tool_use')
    expect(uses.map((block) => (block as { name: string }).name)).toEqual(['write_file', 'run_command'])
    expect((uses[0] as { id: string }).id).toBe('turn-1:call_15413699212027215681')
    const write = recorded.events.find((event) => event.type === 'user_message' && event.patch)
    expect(write?.type === 'user_message' && write.patch).toMatchObject({
      path: '/tmp/agy-probe/hello.txt',
      kind: 'create',
      hunks: [{ lines: ['+hi'] }],
    })
    expect(transcript.lastText).toBe('\n\nDONE')
    expect(recorded.titles).toEqual(['Create File And Run Commands'])
    expect(recorded.contexts.at(-1)).toBe(10282)
  })

  it('emits each tool card once although agy repeats the call in every update', () => {
    const recorded = sink()
    const transcript = new AcpTranscript(recorded)
    transcript.beginTurn('t')
    transcript.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'a',
      name: 'run_command',
      status: 'in_progress',
      rawInput: { CommandLine: 'ls' },
    })
    transcript.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'pending' })
    transcript.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { output: 'x' } })
    transcript.apply({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: { output: 'x' } })
    expect(kinds(recorded.events)).toEqual(['assistant:tool_use', 'user:tool_result'])
  })

  it('replays a loaded session as history without stream deltas', () => {
    const recorded = sink()
    const transcript = new AcpTranscript(recorded)
    transcript.setReplaying(true)
    for (const update of fixtureUpdates('load-replay.ndjson')) {
      transcript.apply(update)
    }
    transcript.setReplaying(false)
    expect(recorded.events.some((event) => event.type === 'stream_delta')).toBe(false)
    expect(kinds(recorded.events)[0]).toBe('user:text')
    expect(kinds(recorded.events).filter((kind) => kind === 'user:tool_result')).toHaveLength(2)
  })

  it('settles tool cards a cancelled turn left open', () => {
    const recorded = sink()
    const transcript = new AcpTranscript(recorded)
    transcript.beginTurn('t')
    transcript.apply({ sessionUpdate: 'tool_call', toolCallId: 'a', name: 'run_command', status: 'in_progress' })
    transcript.settleOpenTools('interrupted')
    const result = recorded.events.at(-1)
    expect(result?.type === 'user_message' && result.message.content).toEqual([
      { type: 'tool_result', tool_use_id: 't:a', content: 'interrupted', is_error: true },
    ])
  })

  it('maps a plan to a checklist', () => {
    const recorded = sink()
    new AcpTranscript(recorded).apply({
      sessionUpdate: 'plan',
      entries: [
        { content: 'one', status: 'completed' },
        { content: 'two', status: 'in_progress' },
      ],
    })
    expect(recorded.checklists).toEqual([
      [
        { text: 'one', status: 'completed' },
        { text: 'two', status: 'in_progress' },
      ],
    ])
  })
})

describe('filePatchFromTexts', () => {
  it('trims the common prefix and suffix to one hunk with context', () => {
    const patch = filePatchFromTexts('f', 'a\nb\nc\nd\ne\nf\ng\n', 'a\nb\nc\nD\ne\nf\ng\n')
    expect(patch).toEqual({
      path: 'f',
      kind: 'update',
      hunks: [{ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7, lines: [' a', ' b', ' c', '-d', '+D', ' e', ' f', ' g'] }],
    })
  })

  it('returns nothing for an unchanged file', () => {
    expect(filePatchFromTexts('f', 'same\n', 'same\n')).toBeUndefined()
  })
})
