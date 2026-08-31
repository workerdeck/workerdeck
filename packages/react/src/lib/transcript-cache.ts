import type { WorkerDeckClient } from '@workerdeck/client'
import type { TranscriptState } from './transcript.ts'

const MAX_ENTRIES = 5

const entries = new Map<string, TranscriptState>()

// NUL separates unambiguously: `identityKey` is JSON.stringify output, so no two pairs spell one key.
export function transcriptCacheKey(client: WorkerDeckClient, sessionId: string): string {
  return `${client.identityKey}\u0000${sessionId}`
}

export function readTranscriptCache(key: string): TranscriptState | undefined {
  return entries.get(key)
}

export function writeTranscriptCache(key: string, state: TranscriptState): void {
  entries.delete(key)
  entries.set(key, state)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      entries.delete(oldest)
    }
  }
}

export function deleteTranscriptCache(key: string): void {
  entries.delete(key)
}

export function clearTranscriptCache(): void {
  entries.clear()
}
