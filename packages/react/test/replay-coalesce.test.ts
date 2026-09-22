import { describe, expect, it } from 'vitest'
import { logCoalesceKey, replayCoalesceKey, transcriptActivity, transcriptProse } from '@workerdeck/protocol'
import type { RateLimitInfo, SessionEvent, SessionEventBody, ShellInfo } from '@workerdeck/protocol'
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

  it('never drops the highest-seq event - the replay hold depends on it', () => {
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

  it('leaves transcript content strictly alone - the fold is order-dependent', () => {
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

  it('coalesces two shell rows under one shell id to the last', () => {
    const full = seqd([shellRow({ status: 'running', bytes: 10 }), shellRow({ status: 'exited', bytes: 40 })])
    expect(replayCoalesceKey(full[0]!)).toBe('shell:sh_1')
    const thin = coalesce(full)
    expect(thin).toHaveLength(1)
    expect(thin[0]?.seq).toBe(full[1]!.seq)
    expect(fold(thin)).toEqual(fold(full))
  })
})

// The gateway's log rule: the latest event per key is kept, the one it supersedes is dropped at append time.
function retainLog(events: SessionEvent[]): SessionEvent[] {
  const log: SessionEvent[] = []
  for (const event of events) {
    const key = logCoalesceKey(event)
    const index = key === undefined ? -1 : log.findIndex((held) => logCoalesceKey(held) === key)
    if (index !== -1) {
      log.splice(index, 1)
    }
    log.push(event)
  }
  return log
}

describe('log coalescing is a subset of replay coalescing', () => {
  const shellRows = (events: SessionEvent[]): SessionEvent[] => events.filter((e) => e.type === 'user_message' && e.shell !== undefined)

  it('keys the shell row exactly as the replay does, and nothing else', () => {
    const row = shellRow({ status: 'running', bytes: 1 })
    expect(logCoalesceKey(row)).toBe('shell:sh_1')
    expect(logCoalesceKey(row)).toBe(replayCoalesceKey(row))
    for (const body of [
      usage(1),
      { type: 'rate_limit', info: limit('five_hour', 1) } as SessionEventBody,
      { type: 'status_changed', status: 'idle' } as SessionEventBody,
      { type: 'context_compacted', uuid: 'c1', pending: true } as SessionEventBody,
      { type: 'checklist', items: [] } as SessionEventBody,
      { type: 'sdk_event', payload: { type: 'system', subtype: 'status' } } as SessionEventBody,
      { type: 'user_message', message: { role: 'user', content: 'hi' }, parentToolUseId: null } as SessionEventBody,
      {
        type: 'user_message',
        message: { role: 'user', content: '<local-command-stdout>$ ls</local-command-stdout>' },
        parentToolUseId: null,
        synthetic: true,
        uuid: 'u1',
      } as SessionEventBody,
    ]) {
      expect(logCoalesceKey(body)).toBeUndefined()
    }
  })

  it('scores zero activity and prose, so the counters a restore recomputes match the ones the live log folded', () => {
    for (const status of ['running', 'exited'] as const) {
      expect(transcriptActivity(shellRow({ status, bytes: 1 }))).toBe(0)
      expect(transcriptProse(shellRow({ status, bytes: 1 }))).toBe(0)
    }
  })

  it('delivers the same coalesced replay from either log, from any afterSeq, and the same fold', () => {
    const full = seqd([
      { type: 'user_message', message: { role: 'user', content: 'start the server' }, parentToolUseId: null },
      shellRow({ status: 'running', bytes: 1 }),
      { type: 'status_changed', status: 'running' },
      usage(1),
      shellRow({ status: 'running', bytes: 2 }),
      { type: 'user_message', message: { role: 'user', content: 'and the tests' }, parentToolUseId: null },
      shellRow({ status: 'running', bytes: 3 }),
      { type: 'status_changed', status: 'idle' },
      usage(2),
      shellRow({ status: 'exited', bytes: 4 }),
      { type: 'user_message', message: { role: 'user', content: 'thanks' }, parentToolUseId: null },
    ])
    const log = retainLog(full)
    expect(log).toHaveLength(full.length - 3)
    expect(shellRows(log).map((e) => e.seq)).toEqual([10])
    expect(log.map((e) => e.seq)).toEqual([1, 3, 4, 6, 8, 9, 10, 11])
    for (let afterSeq = 0; afterSeq <= full.length; afterSeq++) {
      const slice = (events: SessionEvent[]) => coalesce(events.filter((e) => e.seq > afterSeq))
      expect(slice(log)).toEqual(slice(full))
    }
    expect(fold(log)).toEqual(fold(coalesce(full)))
    expect(fold(log).items.filter((item) => item.kind === 'shell')).toHaveLength(1)
  })
})

function shellRow(over: { status: 'running' | 'exited'; bytes: number }): SessionEventBody {
  const shell: ShellInfo = {
    id: 'sh_1',
    sessionId: 'sess-1',
    ordinal: 1,
    command: 'npm run dev',
    label: 'npm run dev',
    cwd: '/work',
    owner: 'user',
    startedAt: 0,
    cols: 120,
    rows: 40,
    ...over,
  }
  return {
    type: 'user_message',
    message: { role: 'user', content: '<local-command-stdout>$ npm run dev</local-command-stdout>' },
    parentToolUseId: null,
    synthetic: true,
    uuid: 'row-1',
    shell,
  }
}
