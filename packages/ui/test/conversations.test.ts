import { describe, expect, it, vi } from 'vitest'
import { WorkerDeckError } from '@workerdeck/client'
import type { UnconfirmedInputRefusal } from '@workerdeck/protocol'
import {
  archivedBannerText,
  conversationList,
  conversationRecovery,
  conversationRowText,
  conversationSpan,
  discardConfirmText,
  startNewConversation,
  type CutClient,
} from '../src/lib/conversations.ts'

const at = Date.UTC(2026, 9, 18, 12, 0)

describe('conversation rows', () => {
  it('spans minutes, hours and days', () => {
    expect(conversationSpan(20_000)).toBe('under a minute')
    expect(conversationSpan(35 * 60_000)).toBe('35m')
    expect(conversationSpan(120 * 60_000)).toBe('2h')
    expect(conversationSpan(134 * 60_000)).toBe('2h 14m')
    expect(conversationSpan(72 * 3_600_000)).toBe('3d')
  })

  it('runs the current conversation to now and leaves an unknown span out', () => {
    const current = conversationRowText({ n: 3, startedAt: at, current: true }, at + 10 * 60_000, 'en-US')
    expect(current).toMatchObject({ title: 'Untitled conversation', duration: '10m', current: true })
    expect(current.date).toContain('Oct 18, 2026')
    const legacy = conversationRowText({ n: 1, current: false })
    expect(legacy).toEqual({ date: 'Date unknown', title: 'Untitled conversation', current: false })
    expect(conversationRowText({ n: 2, transcript: 'unavailable', current: false }).title).toBe('Transcript unavailable')
  })
})

describe('archived banner', () => {
  it('names a past conversation and says when its agent or transcript is gone', () => {
    expect(archivedBannerText({ kind: 'past', at, current: 3, unavailable: false }, 'en-US').headline).toMatch(
      /^Past conversation · Oct 18, 2026/,
    )
    expect(archivedBannerText({ kind: 'past', at, unavailable: false }).note).toBeUndefined()
    expect(archivedBannerText({ kind: 'deleted', at, unavailable: false }).note).toBe('Closed')
    expect(archivedBannerText({ kind: 'deleted', at, unavailable: true }).note).toBe('Closed · Transcript unavailable')
  })
})

function refusal(code: string, inputRevision: string, pendingInput: number, mayIncludePeer = false): WorkerDeckError {
  return new WorkerDeckError('unread input', 409, {
    error: 'unread input',
    code,
    conversation: 4,
    inputRevision,
    pendingInput,
    mayIncludePeer,
  })
}

const done = { session: { id: 's1' }, conversation: 5 } as Awaited<ReturnType<CutClient['newConversation']>>

describe('discard and cut', () => {
  it('states the count and warns about peers only when they may be in it', () => {
    const one: UnconfirmedInputRefusal = {
      error: 'x',
      code: 'unconfirmed_input',
      conversation: 4,
      inputRevision: 'r1',
      pendingInput: 1,
      mayIncludePeer: false,
    }
    expect(discardConfirmText(one).title).toBe('Discard 1 message and start a new conversation?')
    expect(discardConfirmText(one).detail).not.toContain('peer')
    const many = { ...one, pendingInput: 3, mayIncludePeer: true }
    expect(discardConfirmText(many).title).toContain('3 messages')
    expect(discardConfirmText(many).detail).toContain('peer agents')
    expect(discardConfirmText({ ...one, code: 'input_changed' }).detail).toMatch(/^More input arrived/)
  })

  it('cuts straight away when nothing is unread, without asking', async () => {
    const client: CutClient = { newConversation: vi.fn(async () => done), discardAndCut: vi.fn() }
    const confirm = vi.fn(async () => true)
    await expect(startNewConversation(client, 's1', { expectedGeneration: 4 }, confirm)).resolves.toBe(done)
    expect(confirm).not.toHaveBeenCalled()
  })

  it('binds the refusal it showed, and asks again with the new set when input arrived meanwhile', async () => {
    const discardAndCut = vi
      .fn<CutClient['discardAndCut']>()
      .mockRejectedValueOnce(refusal('input_changed', 'r2', 2, true))
      .mockResolvedValueOnce(done)
    const client: CutClient = {
      newConversation: vi.fn(async () => {
        throw refusal('unconfirmed_input', 'r1', 1)
      }),
      discardAndCut,
    }
    const asked: number[] = []
    const result = await startNewConversation(client, 's1', { expectedGeneration: 4, prompt: 'go' }, async (_text, shown) => {
      asked.push(shown.pendingInput)
      return true
    })
    expect(result).toBe(done)
    expect(asked).toEqual([1, 2])
    expect(discardAndCut.mock.calls).toEqual([
      ['s1', { expectedGeneration: 4, inputRevision: 'r1', prompt: 'go' }],
      ['s1', { expectedGeneration: 4, inputRevision: 'r2', prompt: 'go' }],
    ])
  })

  it('does nothing when the person declines, and rethrows any other refusal', async () => {
    const declined: CutClient = {
      newConversation: vi.fn(async () => {
        throw refusal('unconfirmed_input', 'r1', 1)
      }),
      discardAndCut: vi.fn(),
    }
    await expect(startNewConversation(declined, 's1', { expectedGeneration: 4 }, async () => false)).resolves.toBeUndefined()
    expect(declined.discardAndCut).not.toHaveBeenCalled()
    const busy: CutClient = {
      newConversation: vi.fn(async () => {
        throw new WorkerDeckError('session is busy', 409, { error: 'session is busy' })
      }),
      discardAndCut: vi.fn(),
    }
    await expect(startNewConversation(busy, 's1', { expectedGeneration: 4 }, async () => true)).rejects.toThrow('session is busy')
  })
})

describe('session conversations', () => {
  const history = [
    { n: 1, engine: 'claude' as const, cwd: '/w', startedAt: 10, endedAt: 20, title: 'first' },
    { n: 2, engine: 'claude' as const, cwd: '/w', startedAt: 20, endedAt: 30, transcript: 'unavailable' as const },
  ]

  it('lists the current conversation on top and the past ones newest first, for any session', () => {
    expect(conversationList({ conversation: 3, history }, 'now')).toEqual([
      { n: 3, current: true, startedAt: 30, title: 'now' },
      { n: 2, current: false, startedAt: 20, endedAt: 30, transcript: 'unavailable' },
      { n: 1, current: false, startedAt: 10, endedAt: 20, title: 'first' },
    ])
    expect(conversationList({ conversation: 3, closed: true, history }).map((row) => row.current)).toEqual([false, false])
  })

  it('offers a retry for a failed start and a choice only for an uncertain first message', () => {
    expect(conversationRecovery({ conversation: 3, history, startFailed: { n: 3, error: 'boom' } })).toEqual({
      startFailed: { n: 3, error: 'boom' },
    })
    expect(conversationRecovery({ conversation: 3, history, pendingPrompt: { text: 'hi', n: 3, state: 'pending' } })).toEqual({})
    expect(conversationRecovery({ conversation: 3, history, pendingPrompt: { text: 'hi', n: 3, state: 'uncertain' } })).toEqual({
      uncertainPrompt: { n: 3, text: 'hi' },
    })
  })

  it('never sends a target, which a discard could not carry', async () => {
    const newConversation = vi.fn<CutClient['newConversation']>(async () => done)
    const client: CutClient = { newConversation, discardAndCut: vi.fn() }
    const request = { expectedGeneration: 4, target: { cwd: '/elsewhere' } } as unknown as Parameters<typeof startNewConversation>[2]
    await startNewConversation(client, 's1', request, async () => true)
    expect(newConversation).toHaveBeenCalledWith('s1', { expectedGeneration: 4 })
  })
})
