import { describe, expect, it } from 'vitest'
import { logCoalesceKey, replayCoalesceKey, snapshotRetains } from '@workerdeck/protocol'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/lib/transcript.ts'

let seq = 0
function run(state: TranscriptState, bodies: SessionEventBody[]): TranscriptState {
  return bodies.reduce((s, body) => applyEvent(s, { ...body, seq: ++seq, ts: 1000 } as SessionEvent), state)
}

const bash: SessionEventBody = {
  type: 'assistant_message',
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'uv sync' } }] },
  parentToolUseId: null,
  uuid: 'a1',
}

function tool(state: TranscriptState) {
  const item = state.items.find((i) => i.kind === 'tool_call' && i.id === 'bash-1')
  return item?.kind === 'tool_call' ? item : undefined
}

describe('tool_output', () => {
  it('carries the live tail on a running call and drops it with the result', () => {
    let state = run(initialTranscriptState, [bash, { type: 'tool_output', toolUseId: 'bash-1', tail: 'Downloading torch' }])
    expect(tool(state)?.liveTail).toBe('Downloading torch')
    state = run(state, [
      {
        type: 'user_message',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok' }] },
        parentToolUseId: null,
      },
    ])
    expect(tool(state)?.liveTail).toBeUndefined()
    const after = run(state, [{ type: 'tool_output', toolUseId: 'bash-1', tail: 'late' }])
    expect(after.items).toBe(state.items)
  })

  it('ignores a tail for an unknown call and coalesces per call outside snapshots', () => {
    const state = run(initialTranscriptState, [bash])
    expect(run(state, [{ type: 'tool_output', toolUseId: 'nope', tail: 'x' }]).items).toBe(state.items)
    const body: SessionEventBody = { type: 'tool_output', toolUseId: 'bash-1', tail: 'x' }
    expect(replayCoalesceKey(body)).toBe('tool_output:bash-1')
    expect(logCoalesceKey(body)).toBe('tool_output:bash-1')
    expect(snapshotRetains(body)).toBe(false)
  })
})
