import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState, queuedMessages } from '../src/index.ts'

let seq = 0
function event(body: Record<string, unknown>): SessionEvent {
  return { ...body, seq: ++seq, ts: 0 } as unknown as SessionEvent
}

function user(uuid: string, text: string, queued?: true): SessionEvent {
  return event({ type: 'user_message', message: { role: 'user', content: text }, parentToolUseId: null, uuid, ...(queued && { queued }) })
}

describe('queued messages', () => {
  it('holds a queued send until input_consumed names it', () => {
    let state = [user('a', 'first'), user('b', 'second', true), user('c', 'third', true)].reduce(applyEvent, initialTranscriptState)
    expect(queuedMessages(state).map((item) => item.text)).toEqual(['second', 'third'])
    state = applyEvent(state, event({ type: 'input_consumed', uuids: ['b'] }))
    expect(queuedMessages(state).map((item) => item.text)).toEqual(['third'])
    expect(state.items.find((item) => item.id === 'b')).not.toHaveProperty('queued')
    state = applyEvent(state, event({ type: 'input_consumed', uuids: ['c', 'unknown'] }))
    expect(queuedMessages(state)).toEqual([])
  })
})
