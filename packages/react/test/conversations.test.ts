import { beforeEach, describe, expect, it } from 'vitest'
import { WorkerDeckClient } from '@workerdeck/client'
import { archivedView, conversationsOf, followTarget, selectionOf, sessionListed, type SessionInfo } from '@workerdeck/protocol'
import { followStep } from '@workerdeck/protocol'
import {
  carryDraft,
  conversationReadOnly,
  needsArchiveCheck,
  shownSession,
  stashHandedFiles,
  takeHandedFiles,
} from '../src/lib/conversation-follow.ts'
import { clearDrafts, draftKey, readDraft, writeDraft } from '../src/lib/draft-store.ts'
import { successorOf } from '../src/lib/transcript.ts'

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

  it('reads the successor off an archived attach, never off a live one', () => {
    const info = { id: 'a', archived: true as const, supersededBy: 'b' } as SessionInfo
    expect(successorOf({ session: info })).toBe('b')
    expect(successorOf({ session: { ...info, archived: undefined } })).toBeUndefined()
    expect(successorOf({})).toBeUndefined()
  })
})

describe('follow', () => {
  const selection = { kind: 'agent' as const, gateway: 'g', agentId: 'ag' }

  it('lands on the current conversation after two missed rotations', () => {
    const rows = [{ hostId: 'g', info: { id: 'c', agent } }]
    expect(followStep({ selection, shown: 'a', rows, successor: 'b', left: new Set() })).toBe('c')
    expect(followStep({ selection, shown: 'c', rows, left: new Set(['a']) })).toBeUndefined()
  })

  it('takes the one-hop successor while the list still lags', () => {
    const stale = [{ hostId: 'g', info: { id: 'a', agent } }]
    expect(followStep({ selection, shown: 'a', rows: stale, successor: 'b', left: new Set() })).toBe('b')
    expect(followStep({ selection, shown: 'a', rows: [], successor: 'b', left: new Set() })).toBe('b')
    expect(followStep({ selection, shown: 'b', rows: stale, left: new Set(['a']) })).toBeUndefined()
  })

  it('never moves a session selection or an unknown one', () => {
    const rows = [{ hostId: 'g', info: { id: 'c', agent } }]
    expect(
      followStep({ selection: { kind: 'session', gateway: 'g', sessionId: 'a' }, shown: 'a', rows, successor: 'b', left: new Set() }),
    ).toBeUndefined()
    expect(followStep({ selection: undefined, shown: 'a', rows, successor: 'b', left: new Set() })).toBeUndefined()
  })
})

describe('archived view', () => {
  it('renders an archived conversation read-only, whatever the host asked', () => {
    expect(conversationReadOnly(false, { archived: true })).toBe(true)
    expect(conversationReadOnly(false, {})).toBe(false)
    expect(conversationReadOnly(true, undefined)).toBe(true)
  })

  it('re-reads an agent conversation that ended under the view and shows the archive it became', () => {
    const live = { id: 'c', agent, createdAt: 1, status: 'idle' } as SessionInfo
    expect(needsArchiveCheck(live, 'running')).toBe(false)
    expect(needsArchiveCheck(live, 'closed')).toBe(true)
    expect(needsArchiveCheck({ ...live, agent: undefined }, 'closed')).toBe(false)
    expect(needsArchiveCheck({ ...live, archived: true }, 'closed')).toBe(false)
    const archived = { ...live, archived: true as const, lastActivityAt: 9 }
    expect(shownSession(live, undefined)).toBe(live)
    expect(shownSession(live, { ...live, status: 'closed' })).toBe(live)
    expect(shownSession(live, archived)).toBe(archived)
  })

  it('says agent deleted once the agent list lacks it, and past with a way back while it lives', () => {
    const archived = { id: 'c', agent, archived: true as const, createdAt: 1, lastActivityAt: 9 } as SessionInfo
    expect(archivedView(archived, [])).toEqual({ kind: 'deleted', at: 1, unavailable: false })
    expect(archivedView(archived)).toEqual({ kind: 'past', at: 1, unavailable: false })
    expect(archivedView(archived, [{ id: 'ag', sessionId: 'd' }])).toEqual({ kind: 'past', at: 1, current: 'd', unavailable: false })
    expect(archivedView({ ...archived, archived: undefined }, [])).toBeUndefined()
  })

  it('keeps a deleted agent selection on its last conversation instead of moving it', () => {
    const selection = { kind: 'agent' as const, gateway: 'g', agentId: 'ag' }
    expect(followStep({ selection, shown: 'c', rows: [], left: new Set() })).toBeUndefined()
  })
})

describe('composer hand-over', () => {
  const client = new WorkerDeckClient({ baseUrl: 'http://gw/v1' })

  beforeEach(() => {
    const backing = new Map<string, string>()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    }
    clearDrafts()
  })

  it('moves the unsent draft to the successor and leaves the old one empty', () => {
    writeDraft(draftKey(client, 'a'), 'half a thought')
    carryDraft(client, 'a', 'b')
    expect(readDraft(draftKey(client, 'b'))).toBe('half a thought')
    expect(readDraft(draftKey(client, 'a'))).toBe('')
  })

  it('never overwrites a draft the successor already has', () => {
    writeDraft(draftKey(client, 'a'), 'old')
    writeDraft(draftKey(client, 'b'), 'new')
    carryDraft(client, 'a', 'b')
    expect(readDraft(draftKey(client, 'b'))).toBe('new')
  })

  it('hands staged files over once', () => {
    const file = new File(['x'], 'note.txt', { type: 'text/plain' })
    stashHandedFiles(client, 'a', [file])
    expect(takeHandedFiles(client, 'a')).toEqual([file])
    expect(takeHandedFiles(client, 'a')).toEqual([])
  })
})
