import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { replaySlice } from '../src/lib/replay.ts'

function seqd(bodies: SessionEventBody[]): SessionEvent[] {
  return bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))
}

const user = (text: string): SessionEventBody => ({ type: 'user_message', message: { role: 'user', content: text }, parentToolUseId: null })
const status = (value: 'running' | 'idle'): SessionEventBody => ({ type: 'status_changed', status: value })
const sdk: SessionEventBody = { type: 'sdk_event', payload: { type: 'system', subtype: 'task_started' } }
const asked: SessionEventBody = { type: 'permission_requested', request: { id: 'p1' } as never }
const answered: SessionEventBody = { type: 'permission_resolved', requestId: 'p1' } as never
const reset: SessionEventBody = { type: 'conversation_reset' }

function types(events: SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('replaySlice across a reset', () => {
  const log = seqd([
    { type: 'model_changed', model: 'opus' },
    status('running'),
    user('old'),
    sdk,
    asked,
    answered,
    { type: 'tool_output', toolUseId: 't1', tail: 'x' },
    { type: 'checklist', items: [] },
    { type: 'tool_titles', titles: { a: 'A' } },
    { type: 'tool_titles', titles: { b: 'B' } },
    { type: 'file_produced', fileId: 'f1', path: '/a.png' },
    { type: 'file_produced', fileId: 'f2', path: '/a.png' },
    status('idle'),
    reset,
    user('new'),
  ])
  const resetSeq = 14

  it('keeps only the latest session state from before the reset on a client attach', () => {
    const out = replaySlice(log, { afterSeq: 0, resetSeq, coalesceReplay: true })
    expect(out.map((event) => event.seq)).toEqual([1, 9, 10, 12, 13, 14, 15])
    expect(types(out)).toEqual([
      'model_changed',
      'tool_titles',
      'tool_titles',
      'file_produced',
      'status_changed',
      'conversation_reset',
      'user_message',
    ])
  })

  it('leaves the uncoalesced replay to drop transcript content only', () => {
    const out = replaySlice(log, { afterSeq: 0, resetSeq })
    expect(types(out)).toContain('sdk_event')
    expect(types(out)).toContain('permission_requested')
    expect(types(out)).toContain('tool_output')
    expect(out.filter((event) => event.type === 'user_message')).toHaveLength(1)
  })

  it('prunes nothing after the reset and nothing outside the replay window', () => {
    expect(replaySlice(log, { afterSeq: 13, resetSeq, coalesceReplay: true }).map((event) => event.seq)).toEqual([14, 15])
    const noReset = seqd([sdk, user('a'), status('idle')])
    expect(replaySlice(noReset, { afterSeq: 0, coalesceReplay: true })).toHaveLength(3)
  })
})
