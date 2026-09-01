import type { WorkerDeckClient } from '@workerdeck/client'

/**
 * Unsent composer text, kept per session on the client that typed it.
 *
 * A draft is not session state: it never reaches the gateway and never syncs between clients. Two people looking at
 * one session are each mid-sentence in their own way, and a half-written prompt is not something either of them
 * asked to publish.
 *
 * It is persisted rather than merely held in memory because the two ways drafts got lost are different failures. A
 * session switch remounts the composer, which a module-scope map alone would survive; a Vite HMR reload or a VS Code
 * `dev:host` webview re-render replaces the whole document, which it would not.
 */
const KEY = 'workerdeck.drafts.v1'

/** Drafts are a convenience, so the store stays small and drops the least recently touched first. */
const MAX_DRAFTS = 20

type Draft = { text: string; savedAt: number }

let memory: Record<string, Draft> | undefined

function storage(): Storage | undefined {
  try {
    // Through globalThis: this package is typechecked with no DOM lib, and a webview may deny storage outright.
    return (globalThis as { localStorage?: Storage }).localStorage
  } catch {
    return undefined
  }
}

function load(): Record<string, Draft> {
  if (memory) {
    return memory
  }
  memory = {}
  const raw = storage()?.getItem(KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Draft>
      for (const [key, draft] of Object.entries(parsed)) {
        if (typeof draft?.text === 'string' && typeof draft.savedAt === 'number') {
          memory[key] = draft
        }
      }
    } catch {
      // A corrupt blob is not worth a broken composer; start over.
    }
  }
  return memory
}

function persist(drafts: Record<string, Draft>): void {
  const entries = Object.entries(drafts)
  if (entries.length > MAX_DRAFTS) {
    entries.sort((a, b) => b[1].savedAt - a[1].savedAt)
    for (const [key] of entries.slice(MAX_DRAFTS)) {
      delete drafts[key]
    }
  }
  try {
    storage()?.setItem(KEY, JSON.stringify(drafts))
  } catch {
    // Out of quota, or storage denied. The in-memory copy still carries the session switch.
  }
}

// NUL separates unambiguously: `identityKey` is JSON.stringify output, so no two pairs spell one key.
export function draftKey(client: WorkerDeckClient, sessionId: string): string {
  return `${client.identityKey}\u0000${sessionId}`
}

export function readDraft(key: string): string {
  return load()[key]?.text ?? ''
}

export function writeDraft(key: string, text: string, now = Date.now()): void {
  const drafts = load()
  // An empty draft is the absence of one: keeping it would evict a real draft under the cap.
  if (text.trim() === '') {
    if (drafts[key] === undefined) {
      return
    }
    delete drafts[key]
  } else {
    drafts[key] = { text, savedAt: now }
  }
  persist(drafts)
}

export function clearDrafts(): void {
  memory = {}
  try {
    storage()?.removeItem(KEY)
  } catch {}
}
