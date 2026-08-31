import { randomUUID } from 'node:crypto'
import { attachmentKind, normalizeMediaType, type AttachmentInput } from '@workerdeck/core'
import type { MessageAttachment } from '@workerdeck/protocol'

export type AttachmentStoreOptions = {
  maxFileBytes?: number
  maxSessionBytes?: number
}

export type AttachmentRejection =
  | { code: 'too_large'; message: string }
  | { code: 'session_full'; message: string }
  | { code: 'unsupported_type'; message: string }
  | { code: 'empty'; message: string }

export type PutResult = { ok: true; attachment: MessageAttachment } | { ok: false; error: AttachmentRejection }

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024

export class AttachmentStore {
  #bySession = new Map<string, Map<string, AttachmentInput>>()
  #maxFileBytes: number
  #maxSessionBytes: number

  constructor(options: AttachmentStoreOptions = {}) {
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.#maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
  }

  get maxFileBytes(): number {
    return this.#maxFileBytes
  }

  put(sessionId: string, name: string, mediaType: string, body: Buffer): PutResult {
    if (body.length === 0) {
      return { ok: false, error: { code: 'empty', message: 'attachment is empty' } }
    }
    if (body.length > this.#maxFileBytes) {
      return {
        ok: false,
        error: {
          code: 'too_large',
          message: `attachment is larger than the ${this.#maxFileBytes}-byte limit`,
        },
      }
    }
    const type = normalizeMediaType(mediaType)
    if (!attachmentKind(type)) {
      return {
        ok: false,
        error: { code: 'unsupported_type', message: `unsupported media type: ${type}` },
      }
    }
    const held = this.#bySession.get(sessionId) ?? new Map<string, AttachmentInput>()
    const heldBytes = [...held.values()].reduce((sum, a) => sum + a.bytes, 0)
    if (heldBytes + body.length > this.#maxSessionBytes) {
      return {
        ok: false,
        error: {
          code: 'session_full',
          message: `session is already holding ${heldBytes} bytes of attachments (limit ${this.#maxSessionBytes})`,
        },
      }
    }
    const attachment: AttachmentInput = {
      id: randomUUID(),
      name: safeName(name),
      mediaType: type,
      bytes: body.length,
      data: body.toString('base64'),
    }
    held.set(attachment.id, attachment)
    this.#bySession.set(sessionId, held)
    return { ok: true, attachment: ref(attachment) }
  }

  get(sessionId: string, id: string): AttachmentInput | undefined {
    return this.#bySession.get(sessionId)?.get(id)
  }

  resolve(sessionId: string, ids: readonly string[]): { ok: true; attachments: AttachmentInput[] } | { ok: false; missing: string[] } {
    const held = this.#bySession.get(sessionId)
    const attachments: AttachmentInput[] = []
    const missing: string[] = []
    for (const id of ids) {
      const found = held?.get(id)
      if (found) {
        attachments.push(found)
      } else {
        missing.push(id)
      }
    }
    return missing.length ? { ok: false, missing } : { ok: true, attachments }
  }

  drop(sessionId: string): void {
    this.#bySession.delete(sessionId)
  }
}

function ref(attachment: AttachmentInput): MessageAttachment {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
  }
}

function safeName(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? ''
  // oxlint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'attachment'
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}
