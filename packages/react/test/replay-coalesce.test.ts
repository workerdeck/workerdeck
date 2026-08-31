import { describe, expect, it } from 'vitest'
import { replayCoalesceKey } from '@workerdeck/protocol'
import type { RateLimitInfo, SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

function seqd(bodies: SessionEventBody[]): SessionEvent[] {
  return bodies.map((body, index) => ({ ...body, seq: index + 1, ts: 1000 + index }))
}

// A deliberate second implementation of the gateway's rule: a disagreement with `staleReplaySeqs` is a bug in one of them.
function coalesce(events: SessionEvent[]): SessionEvent[] {
  const stale = new Set<number>()
  const seen = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const key = replayCoalesceKey(events[i]!)
    if (key === undefined) {
      continue
    }
    if (seen.has(key)) {
      stale.add(events[i]!.seq)
    } else {
      seen.add(key)
    }
  }
  return events.filter((e) => !stale.has(e.seq))
}

function fold(events: SessionEvent[]): TranscriptState {
  return events.reduce(applyEvent, initialTranscriptState)
}

function limit(type: string, utilization: number): RateLimitInfo {
  return { rateLimitType: type, utilization, status: 'allowed' } as RateLimitInfo
}

function usage(total: number): SessionEventBody {
  return {
    type: 'context_usage',
    usage: { totalTokens: total, maxTokens: 200_000, percentage: total / 2000, categories: [] },
  }
}

describe('replay coalescing is unobservable', () => {
  it('lands on the same state as the full log, for a session of many turns', () => {
    const bodies: SessionEventBody[] = [
      {
        type: 'system_init',
        sdkSessionId: 'sdk-1',
        model: 'm',
        cwd: '/w',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      },
      { type: 'capabilities', models: [], commands: [], defaultModel: 'm' },
    ]
    for (let turn = 1; turn <= 50; turn++) {
      bodies.push({ type: 'status_changed', status: 'running' })
      bodies.push({
        type: 'user_message',
        message: { role: 'user', content: `turn ${turn}` },
        parentToolUseId: null,
      })
      bodies.push(usage(turn * 1000))
      bodies.push({ type: 'rate_limit', info: limit('five_hour', turn) })
      bodies.push({ type: 'rate_limit', info: limit('seven_day', turn * 1.2) })
      bodies.push({ type: 'rate_limit', info: limit('seven_day_fable', turn * 1.1) })
      bodies.push({ type: 'status_changed', status: 'idle' })
    }
    const full = seqd(bodies)
    const thin = coalesce(full)

    expect(fold(thin)).toEqual(fold(full))
    expect(thin.length).toBeLessThan(full.length)
    expect(full.length - thin.length).toBe(49 * 4 + 99)
  })

  it('keeps the last reading of EVERY window, not just the most recent poll', () => {
    const full = seqd([
      { type: 'rate_limit', info: limit('five_hour', 10) },
      { type: 'rate_limit', info: limit('seven_day', 20) },
      { type: 'rate_limit', info: limit('five_hour', 11) },
      { type: 'rate_limit', info: limit('seven_day', 21) },
    ])
    const state = fold(coalesce(full))
    expect(state.rateLimits?.five_hour?.utilization).toBe(11)
    expect(state.rateLimits?.seven_day?.utilization).toBe(21)
    expect(fold(coalesce(full))).toEqual(fold(full))
  })

  it('never drops the highest-seq event — the replay hold depends on it', () => {
    for (const tail of [
      usage(9),
      { type: 'rate_limit', info: limit('five_hour', 9) } as SessionEventBody,
      { type: 'status_changed', status: 'idle' } as SessionEventBody,
    ]) {
      const full = seqd([usage(1), { type: 'status_changed', status: 'running' }, usage(2), tail])
      const thin = coalesce(full)
      expect(thin.at(-1)?.seq).toBe(full.at(-1)?.seq)
      expect(fold(thin).lastSeq).toBe(fold(full).lastSeq)
    }
  })

  it('leaves transcript content strictly alone — the fold is order-dependent', () => {
    const full = seqd([
      { type: 'user_message', message: { role: 'user', content: 'hi' }, parentToolUseId: null },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'par' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'tial' } },
        parentToolUseId: null,
        uuid: 's2',
      },
      usage(1),
      usage(2),
    ])
    const thin = coalesce(full)
    expect(full.length - thin.length).toBe(1)
    expect(thin.filter((e) => e.type === 'stream_delta')).toHaveLength(2)
    expect(fold(thin)).toEqual(fold(full))
  })

  it('refuses the kinds whose reducer case is not a plain replace', () => {
    expect(replayCoalesceKey({ type: 'capabilities', models: [], commands: [] })).toBeUndefined()
    expect(replayCoalesceKey({ type: 'model_changed', model: undefined })).toBeUndefined()
    expect(
      replayCoalesceKey({
        type: 'system_init',
        sdkSessionId: 's',
        model: 'm',
        cwd: '/w',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      }),
    ).toBeUndefined()
    const caps = seqd([
      { type: 'capabilities', models: [], commands: [], defaultModel: 'default-m' },
      { type: 'capabilities', models: [], commands: [] },
    ])
    expect(fold(caps).defaultModel).toBe('default-m')
    const models = seqd([
      { type: 'model_changed', model: 'chosen' },
      { type: 'model_changed', model: undefined },
    ])
    expect(fold(models).model).toBe('chosen')
  })
})
