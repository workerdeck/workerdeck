import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { replayRetains, supersededDeltaSeqs } from '@workerdeck/protocol'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

function seqd(bodies: SessionEventBody[]): SessionEvent[] {
  return bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))
}

function fold(events: readonly SessionEvent[]): TranscriptState {
  return events.reduce(applyEvent, initialTranscriptState)
}

// The gateway's coalesced replay as far as deltas go: the last event always, otherwise retained and not superseded.
function replay(events: readonly SessionEvent[], afterSeq = 0): SessionEvent[] {
  const superseded = supersededDeltaSeqs(events, afterSeq)
  const lastSeq = events.at(-1)?.seq ?? 0
  return events.filter((event) => event.seq > afterSeq && (event.seq === lastSeq || (replayRetains(event) && !superseded.has(event.seq))))
}

function delta(kind: 'text_delta' | 'thinking_delta', chunk: string, parent: string | null = null): SessionEventBody {
  const body = kind === 'text_delta' ? { type: kind, text: chunk } : { type: kind, thinking: chunk }
  return { type: 'stream_delta', event: { type: 'content_block_delta', delta: body }, parentToolUseId: parent, uuid: 'u' }
}

function message(content: unknown[], parent: string | null = null, uuid = 'm'): SessionEventBody {
  return { type: 'assistant_message', message: { role: 'assistant', content }, parentToolUseId: parent, uuid } as SessionEventBody
}

const user: SessionEventBody = { type: 'user_message', message: { role: 'user', content: 'go' }, parentToolUseId: null }
const done: SessionEventBody = { type: 'turn_result', subtype: 'success', isError: false, durationMs: 1, totalCostUsd: 0 } as SessionEventBody

describe('superseded deltas are unobservable', () => {
  it('drops the deltas a complete message repeats, and lands on the same state', () => {
    const full = seqd([
      user,
      delta('thinking_delta', 'I should '),
      delta('thinking_delta', 'look.'),
      delta('text_delta', 'Looking.'),
      message([
        { type: 'thinking', thinking: 'I should look.', signature: 's' },
        { type: 'text', text: 'Looking.' },
      ]),
      done,
    ])
    expect([...supersededDeltaSeqs(full, 0)].sort()).toEqual([2, 3, 4])
    expect(fold(replay(full))).toEqual(fold(full))
  })

  it('keeps streamed thinking a message with an empty thinking block takes over', () => {
    const full = seqd([
      user,
      delta('thinking_delta', 'only streamed'),
      delta('text_delta', 'Hi.'),
      message([
        { type: 'thinking', thinking: '', signature: 's' },
        { type: 'text', text: 'Hi.' },
      ]),
      done,
    ])
    expect([...supersededDeltaSeqs(full, 0)]).toEqual([3])
    expect(fold(replay(full))).toEqual(fold(full))
    expect(fold(replay(full)).items.some((item) => item.kind === 'thinking' && item.text === 'only streamed')).toBe(true)
  })

  it('keeps deltas a turn_result finalizes because no message followed', () => {
    const full = seqd([user, delta('thinking_delta', 'cut off'), delta('text_delta', 'partial'), done, message([{ type: 'text', text: 'late' }])])
    expect(supersededDeltaSeqs(full, 0).size).toBe(0)
    expect(fold(replay(full))).toEqual(fold(full))
  })

  it('judges each agent by its own next message', () => {
    const full = seqd([
      user,
      delta('thinking_delta', 'lead thinks'),
      delta('thinking_delta', 'sub thinks', 'task-1'),
      message([{ type: 'text', text: 'sub done' }], 'task-1', 'm1'),
      delta('text_delta', 'lead says'),
      done,
    ])
    expect([...supersededDeltaSeqs(full, 0)]).toEqual([3])
    expect(fold(replay(full))).toEqual(fold(full))
  })

  it('never reaches below afterSeq, so a resumed attach folds the same', () => {
    const full = seqd([user, delta('thinking_delta', 'a'), delta('thinking_delta', 'b'), message([{ type: 'text', text: 'x' }]), done])
    expect([...supersededDeltaSeqs(full, 2)]).toEqual([3])
    const base = fold(full.slice(0, 2))
    expect(replay(full, 2).reduce(applyEvent, base)).toEqual(fold(full))
  })

  const fixture = join(import.meta.dirname, '../../../crates/bench/fixtures/session.jsonl')
  it.runIf(existsSync(fixture))('lands on the same state over the bench session, from every fifth afterSeq', () => {
    const full = readFileSync(fixture, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(0, 12_000)
      .map((line) => (JSON.parse(line) as { event: SessionEvent }).event)
    const thin = replay(full)
    expect(thin.length).toBeLessThan(full.length / 10)
    expect(fold(thin)).toEqual(fold(full))
    for (let at = 0; at < full.length; at += Math.floor(full.length / 5)) {
      const afterSeq = full[at]!.seq
      expect(replay(full, afterSeq).reduce(applyEvent, fold(full.slice(0, at + 1)))).toEqual(fold(full))
    }
  })
})
