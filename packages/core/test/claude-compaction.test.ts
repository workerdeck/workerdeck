import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner } from '../src/engines/claude/runner.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'

function status(over: Record<string, unknown>): SDKMessage {
  return { type: 'system', subtype: 'status', uuid: 'uuid-s', session_id: 'sdk-session-1', ...over } as unknown as SDKMessage
}

function boundary(over: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'uuid-b',
    session_id: 'sdk-session-1',
    compact_metadata: { trigger: 'manual', pre_tokens: 148_000, post_tokens: 32_000, ...over },
  } as unknown as SDKMessage
}

function makeRunner() {
  const harness = fakeHarness()
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  return { harness, runner, events }
}

function compactions(events: SessionEvent[]) {
  return events.filter((e) => e.type === 'context_compacted') as unknown as Array<Record<string, unknown>>
}

describe('SessionRunner context compaction', () => {
  it('draws a row while it compacts and settles that same row on the boundary', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(status({ status: 'compacting' }))
    harness.emit(status({ status: 'compacting' }))
    harness.emit(boundary())
    await tick()

    const rows = compactions(events)
    expect(rows.map((r) => r.pending)).toEqual([true, true, undefined])
    // One id across all three: the boundary has a uuid of its own, but it is the *end* of a
    // compaction that already has a row, so the runner correlates rather than opening a second.
    expect(new Set(rows.map((r) => r.uuid)).size).toBe(1)
    expect(rows.at(-1)).toMatchObject({ trigger: 'manual', preTokens: 148_000, postTokens: 32_000 })
  })

  it('reports a failed compaction on the row rather than leaving it spinning', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(status({ status: 'compacting' }))
    harness.emit(status({ status: null, compact_result: 'failed', compact_error: 'the model refused' }))
    await tick()

    const rows = compactions(events)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ uuid: rows[0]!.uuid, error: 'the model refused' })
    expect(rows[1]!.pending).toBeUndefined()
  })

  it('never leaves a boundary unemitted for a compaction nobody announced', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(boundary({ trigger: 'auto', post_tokens: undefined }))
    await tick()

    const rows = compactions(events)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ uuid: 'uuid-b', trigger: 'auto' })
    expect(rows[0]!.pending).toBeUndefined()
  })
})
