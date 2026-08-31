import type { WorkerDeckClient } from '@workerdeck/client'
import type { TranscriptState } from './transcript.ts'

const MAX_ENTRIES = 5

const entries = new Map<string, TranscriptState>()

// NUL separates unambiguously: `identityKey` is JSON.stringify output, so no two pairs spell one key.
export const transcriptCacheKey = (client: WorkerDeckClient, sessionId: string): string => `${client.identityKey}\u0000${sessionId}`

export const readTranscriptCache = (key: string): TranscriptState | undefined => entries.get(key)

export const writeTranscriptCache = (key: string, state: TranscriptState): void => {
  entries.delete(key)
  entries.set(key, state)
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) {
      entries.delete(oldest)
    }
  }
}

export const deleteTranscriptCache = (key: string): void => {
  entries.delete(key)
}

export const clearTranscriptCache = (): void => {
  entries.clear()
}
