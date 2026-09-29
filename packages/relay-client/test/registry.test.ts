import { describe, expect, it } from 'vitest'
import { canonicalJson, createRegistryPublisher, digestOf, parseRelayPeerId, registryHash, type RelaySessionEntry } from '../src/index.ts'

function entry(id: string, extra: Partial<RelaySessionEntry> = {}): RelaySessionEntry {
  return { id, status: 'idle', cwd: `/w/${id}`, createdAt: 1, pendingPermissionCount: 0, live: true, ...extra }
}

describe('registry publisher', () => {
  it('sends only what changed, removes what vanished, and stays quiet otherwise', () => {
    const publisher = createRegistryPublisher()
    expect(publisher.snapshot([entry('a'), entry('b')]).seq).toBe(1)
    expect(publisher.delta([entry('a'), entry('b')])).toBeUndefined()
    expect(publisher.delta([entry('a', { status: 'running' })])).toEqual({
      t: 'registry.delta',
      seq: 2,
      upsert: [entry('a', { status: 'running' })],
      remove: ['b'],
    })
  })

  it('digests the same on both sides of a JSON round trip', () => {
    const publisher = createRegistryPublisher()
    const entries = [
      entry('b', { title: 'x', model: undefined }),
      entry('a', { contextUsage: { totalTokens: 1, maxTokens: 2, percentage: 50 } }),
    ]
    publisher.snapshot(entries)
    const received = JSON.parse(JSON.stringify(entries)) as RelaySessionEntry[]
    const relaySide = registryHash(received.map((row) => [row.id, canonicalJson(row)]))
    expect(publisher.digest().hash).toBe(relaySide)
    expect(digestOf(received)).toEqual({ count: 2, hash: relaySide })
  })
})

describe('parseRelayPeerId', () => {
  it('splits on the first colon and refuses a bare or malformed id', () => {
    expect(parseRelayPeerId('mac-mini:abc:def')).toEqual({ gateway: 'mac-mini', id: 'abc:def' })
    expect(parseRelayPeerId('abc')).toBeUndefined()
    expect(parseRelayPeerId('Mac:abc')).toBeUndefined()
    expect(parseRelayPeerId('mac:')).toBeUndefined()
  })
})
