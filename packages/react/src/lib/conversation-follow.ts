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
