import { describe, expect, it, vi } from 'vitest'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  addressKey,
  addressOf,
  archivedView,
  clearContextOffered,
  isHistorical,
  newConversationGate,
  sameAddress,
} from '@workerdeck/protocol'
import { conversationReadOnly, useArchivedView } from '../src/hooks/use-archived-view.ts'
import { renderHook } from './hook-runner.ts'

describe('session address', () => {
  it('keys the current conversation by the bare id and a past one by id and n', () => {
    expect(addressKey({ id: 'a' })).toBe('a')
    expect(addressKey({ id: 'a', conversation: 2 })).toBe('a#2')
    expect(sameAddress({ id: 'a' }, { id: 'a' })).toBe(true)
    expect(sameAddress({ id: 'a' }, { id: 'a', conversation: 1 })).toBe(false)
  })

  it('reads the current conversation number as the current address', () => {
    expect(addressOf('a', 3, 3)).toEqual({ id: 'a' })
    expect(addressOf('a', 2, 3)).toEqual({ id: 'a', conversation: 2 })
    expect(addressOf('a')).toEqual({ id: 'a' })
    expect(isHistorical(addressOf('a', 2, 3))).toBe(true)
    expect(isHistorical({ id: 'a' })).toBe(false)
  })
})

describe('archived view', () => {
  it('renders a past conversation read-only, whatever the host asked', () => {
    expect(conversationReadOnly(false, { id: 'a', conversation: 1 })).toBe(true)
    expect(conversationReadOnly(false, { id: 'a' })).toBe(false)
    expect(conversationReadOnly(true, undefined)).toBe(true)
  })

  it('says past with the way back while the session lives, deleted once it is gone, nothing on the current one', () => {
    const info = { createdAt: 1 }
    expect(archivedView({ id: 'a', conversation: 1 }, info, { conversation: 3 })).toEqual({
      kind: 'past',
      at: 1,
      current: 3,
      unavailable: false,
    })
    expect(archivedView({ id: 'a', conversation: 1 }, info)).toEqual({ kind: 'past', at: 1, unavailable: false })
    expect(archivedView({ id: 'a', conversation: 1 }, info, { retired: true })).toEqual({ kind: 'deleted', at: 1, unavailable: false })
    expect(archivedView({ id: 'a', conversation: 1 }, { ...info, transcript: 'unavailable' })?.unavailable).toBe(true)
    expect(archivedView({ id: 'a' }, info, { conversation: 3 })).toBeUndefined()
  })
})

describe('conversation gates', () => {
  it('offers Clear context on any live session, named or not, and never on a past conversation', () => {
    expect(clearContextOffered({ status: 'idle' })).toBe(true)
    expect(clearContextOffered({ status: 'closed' })).toBe(false)
  })

  it('opens New conversation only once the current one has something in it and is idle', () => {
    expect(newConversationGate({ status: 'idle', sdkSessionId: 'x' }).enabled).toBe(true)
    expect(newConversationGate({ status: 'idle' }).enabled).toBe(false)
    expect(newConversationGate({ status: 'running', sdkSessionId: 'x' }).enabled).toBe(false)
  })
})

describe('useArchivedView', () => {
  const info = { createdAt: 1 }
  const client = (body: Record<string, unknown>) =>
    ({ conversations: vi.fn(async () => body) }) as unknown as WorkerDeckClient & { conversations: ReturnType<typeof vi.fn> }

  it('reads a hidden current conversation as past, not deleted, and only a closed session as deleted', async () => {
    const hiddenApi = client({ history: [] })
    const closedApi = client({ closed: true, history: [] })
    const hidden = renderHook(() => useArchivedView(hiddenApi, { id: 'a', conversation: 1 }, info))
    await vi.waitFor(() => expect(hidden.current).toEqual({ kind: 'past', at: 1, unavailable: false }))
    const closed = renderHook(() => useArchivedView(closedApi, { id: 'a', conversation: 1 }, info))
    await vi.waitFor(() => expect(closed.current?.kind).toBe('deleted'))
  })

  it('reads the current conversation again for every past conversation it shows', async () => {
    const api = client({ conversation: 3, history: [] })
    let address = { id: 'a', conversation: 1 }
    const view = renderHook(() => useArchivedView(api, address, info))
    await vi.waitFor(() => expect(view.current?.current).toBe(3))
    address = { id: 'a', conversation: 2 }
    view.rerender()
    await vi.waitFor(() => expect(api.conversations).toHaveBeenCalledTimes(2))
  })
})
