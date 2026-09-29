import { createHash } from 'node:crypto'
import type { DeltaFrame, DigestFrame, RelaySessionEntry, SnapshotFrame } from './frames.ts'

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function registryHash(entries: Iterable<[string, string]>): string {
  const hash = createHash('sha256')
  for (const [id, json] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(id).update('\n').update(json).update('\n')
  }
  return hash.digest('base64url')
}

export function digestOf(entries: readonly RelaySessionEntry[]): { count: number; hash: string } {
  return { count: entries.length, hash: registryHash(entries.map((entry) => [entry.id, canonicalJson(entry)])) }
}

export type RegistryPublisher = {
  snapshot(entries: readonly RelaySessionEntry[]): SnapshotFrame
  delta(entries: readonly RelaySessionEntry[]): DeltaFrame | undefined
  digest(): DigestFrame
}

// Diffs what the host reports against what was last sent, so a session that vanished by any path is
// removed on the next tick. Nothing listens for session events; the snapshot is the only input.
export function createRegistryPublisher(): RegistryPublisher {
  let sent = new Map<string, string>()
  let seq = 0

  const index = (entries: readonly RelaySessionEntry[]): Map<string, string> =>
    new Map(entries.map((entry) => [entry.id, canonicalJson(entry)]))

  return {
    snapshot(entries) {
      sent = index(entries)
      seq += 1
      return { t: 'registry.snapshot', seq, entries: [...entries] }
    },
    delta(entries) {
      const next = index(entries)
      const upsert = entries.filter((entry) => sent.get(entry.id) !== next.get(entry.id))
      const remove = [...sent.keys()].filter((id) => !next.has(id))
      if (upsert.length === 0 && remove.length === 0) {
        return undefined
      }
      sent = next
      seq += 1
      return { t: 'registry.delta', seq, upsert, remove }
    },
    digest() {
      return { t: 'registry.digest', seq, count: sent.size, hash: registryHash(sent) }
    },
  }
}
