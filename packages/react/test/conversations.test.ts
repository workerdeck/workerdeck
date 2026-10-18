import { describe, expect, it } from 'vitest'
import { conversationsOf, followTarget, selectionOf, sessionListed } from '@workerdeck/protocol'
import { applyEvent, initialTranscriptState } from '../src/lib/transcript.ts'

const agent = { id: 'ag', name: 'WD-Test' }

describe('conversations', () => {
  it('drops archived sessions from the list', () => {
    expect(sessionListed({})).toBe(true)
    expect(sessionListed({ archived: true })).toBe(false)
  })

  it('selects an agent card as the agent and a past conversation as itself', () => {
    expect(selectionOf('g', { id: 'a', agent })).toEqual({ kind: 'agent', gateway: 'g', agentId: 'ag' })
    expect(selectionOf('g', { id: 'a', agent, archived: true })).toEqual({ kind: 'session', gateway: 'g', sessionId: 'a' })
    expect(selectionOf('g', { id: 'p' })).toEqual({ kind: 'session', gateway: 'g', sessionId: 'p' })
  })

  it('follows the agent to its current conversation after rotations it never saw', () => {
    const rows = [
      { hostId: 'g', info: { id: 'a', agent, archived: true as const } },
      { hostId: 'other', info: { id: 'x', agent } },
      { hostId: 'g', info: { id: 'c', agent } },
    ]
    expect(followTarget({ kind: 'agent', gateway: 'g', agentId: 'ag' }, rows)).toBe('c')
    expect(followTarget({ kind: 'agent', gateway: 'g', agentId: 'gone' }, rows)).toBeUndefined()
    expect(followTarget({ kind: 'session', gateway: 'g', sessionId: 'a' }, rows)).toBe('a')
  })

  it('lists conversations newest first, legacy ids without dates', () => {
    const rows = conversationsOf({
      sessionId: 'c',
      pastSessions: ['a', 'b'],
      conversations: [
        { sessionId: 'b', startedAt: 2, endedAt: 3 },
        { sessionId: 'c', startedAt: 3 },
      ],
    })
    expect(rows.map((row) => [row.sessionId, row.current, row.startedAt])).toEqual([
      ['c', true, 3],
      ['b', false, 2],
      ['a', false, undefined],
    ])
    expect(conversationsOf({ sessionId: 'c', pastSessions: ['a'] }).map((row) => row.sessionId)).toEqual(['c', 'a'])
  })

  it('the transcript reducer ignores session_superseded', () => {
    const next = applyEvent(initialTranscriptState, { type: 'session_superseded', successor: 'b', seq: 1, ts: 1 })
    expect(next.items).toEqual(initialTranscriptState.items)
  })
})
