import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { staleReplaySeqs } from '../src/lib/replay.ts'

function seqd(bodies: SessionEventBody[]): SessionEvent[] {
  return bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))
}

function usage(total: number): SessionEventBody {
  return {
    type: 'context_usage',
    usage: { totalTokens: total, maxTokens: 200_000, percentage: 1, categories: [] },
  }
}

function limit(rateLimitType: string, utilization: number): SessionEventBody {
  return {
    type: 'rate_limit',
    info: { rateLimitType, utilization, status: 'allowed' } as never,
  }
}

describe('staleReplaySeqs', () => {
  it('keeps the last of each key and marks the rest stale', () => {
    const events = seqd([usage(1), usage(2), usage(3)])
    expect(staleReplaySeqs(events, 0)).toEqual(new Set([1, 2]))
  })

  it('keys rate limits per window', () => {
    const events = seqd([limit('five_hour', 1), limit('seven_day', 2), limit('five_hour', 3)])
    expect(staleReplaySeqs(events, 0)).toEqual(new Set([1]))
  })

  it('never marks the highest-seq event stale — the replay hold depends on it', () => {
    const events = seqd([usage(1), usage(2), usage(3)])
    expect(staleReplaySeqs(events, 0).has(events.at(-1)!.seq)).toBe(false)
  })

  it('leaves transcript content alone', () => {
    const events = seqd([
      { type: 'user_message', message: { role: 'user', content: 'a' }, parentToolUseId: null },
      { type: 'user_message', message: { role: 'user', content: 'b' }, parentToolUseId: null },
      { type: 'turn_result', subtype: 'success', durationMs: 1, totalCostUsd: 0 } as never,
    ])
    expect(staleReplaySeqs(events, 0).size).toBe(0)
  })

  it('honours afterSeq — an event outside the replay window suppresses nothing', () => {
    const events = seqd([usage(1), usage(2), usage(3)])
    // Replaying only seq 3: seq 1 and 2 are out of scope, not stale.
    expect(staleReplaySeqs(events, 2).size).toBe(0)
    expect(staleReplaySeqs(events, 1)).toEqual(new Set([2]))
  })

  it('is inert on an empty or key-less log', () => {
    expect(staleReplaySeqs([], 0).size).toBe(0)
    expect(staleReplaySeqs(seqd([{ type: 'skills', skills: [] }]), 0).size).toBe(0)
  })
})
