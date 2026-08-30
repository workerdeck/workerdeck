import { randomUUID } from 'node:crypto'
import { attachmentKind, normalizeMediaType, type AttachmentInput } from '@workerdeck/core'
import type { MessageAttachment } from '@workerdeck/protocol'

export type AttachmentStoreOptions = {
  /** Largest single upload. Default 10 MiB. */
  maxFileBytes?: number
  /** Ceiling on everything one session is holding. Default 64 MiB. */
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

/**
 * Per-session hold for files the user attached to a message.
 *
 * In memory, and deliberately so. An attachment is only *needed* for the instant
 * between the upload and the message that names it; everything after that is
 * convenience (a client re-rendering a thumbnail after a reattach). That is the
 * same bargain `GET /sessions/:id/files` makes — the session's lifetime, no
 * durability tier — and it keeps the gateway from accumulating a photo library
 * on disk that nobody asked it to look after.
 *
 * Both caps are enforced here rather than at the route, so a host embedding the
 * server cannot forget one: a single file that is too big is a 413, and so is a
 * session whose total would go over.
 */
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

  /** The stored record, bytes included — for the download route and for the send
   * path that turns ids into content blocks. */
  get(sessionId: string, id: string): AttachmentInput | undefined {
    return this.#bySession.get(sessionId)?.get(id)
  }

  /**
   * Resolve the ids a `user_message` named, in the order given.
   *
   * Missing ids are reported rather than skipped: a message that quietly lost its
   * picture reads as the model ignoring it, which is a far worse failure than a
   * command that errors.
   */
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

/**
 * A display name, not a path. The name is echoed back to clients and put in front
 * of the model in the text-attachment envelope, so directory separators, control
 * characters and unbounded length all come off here.
 */
function safeName(name: string): string {
  const leaf = name.split(/[/\\]/).pop() ?? ''
  // Control characters, plus the two delimiters of the text-attachment envelope.
  // The control range is exactly what makes this worth doing: the name is
  // client-supplied and ends up both in a response header and in front of a model.
  // oxlint-disable-next-line no-control-regex
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f"<>]/g, '').trim()
  if (cleaned === '' || cleaned === '.' || cleaned === '..') {
    return 'attachment'
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned
}
