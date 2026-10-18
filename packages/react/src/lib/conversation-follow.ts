import type { SessionInfo, SessionStatus } from '@workerdeck/protocol'
import type { WorkerDeckClient } from '@workerdeck/client'
import { draftKey, readDraft, writeDraft } from './draft-store.ts'

const handedFiles = new Map<string, File[]>()

export function stashHandedFiles(client: WorkerDeckClient, from: string, files: readonly File[]): void {
  if (files.length > 0) {
    handedFiles.set(draftKey(client, from), [...files])
  }
}

export function takeHandedFiles(client: WorkerDeckClient, from: string): File[] {
  const key = draftKey(client, from)
  const files = handedFiles.get(key) ?? []
  handedFiles.delete(key)
  return files
}

export function carryDraft(client: WorkerDeckClient, from: string, to: string): void {
  const source = draftKey(client, from)
  const target = draftKey(client, to)
  const text = readDraft(source)
  if (text.trim() === '') {
    return
  }
  if (readDraft(target).trim() === '') {
    writeDraft(target, text)
  }
  writeDraft(source, '')
}

// An agent's conversation that ended under a live view may have been archived (the agent was deleted); only a fresh read
// of the record tells, because the attach frame is never refreshed.
export function needsArchiveCheck(
  session: Pick<SessionInfo, 'agent' | 'archived'> | undefined,
  status: SessionStatus | undefined,
): boolean {
  return session?.agent !== undefined && session.archived !== true && (status === 'closed' || status === 'failed')
}

export function shownSession<T extends Pick<SessionInfo, 'archived'>>(live: T | undefined, reread: T | undefined): T | undefined {
  return reread?.archived === true ? reread : live
}

export function conversationReadOnly(readOnly: boolean, session: Pick<SessionInfo, 'archived'> | undefined): boolean {
  return readOnly || session?.archived === true
}
