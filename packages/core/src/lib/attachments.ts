import type { MessageAttachment } from '@workerdeck/protocol'

/**
 * An attachment plus its bytes — what the host hands a runner at send time.
 *
 * The split matters: `data` goes into the message the engine sends and nowhere
 * else. What the runner emits into the seq-numbered event log is the
 * {@link MessageAttachment} half, so replay and parking stay cheap (see the
 * protocol's note on why the bytes are not on the wire).
 */
export type AttachmentInput = MessageAttachment & {
  /** Base64, no data-URL prefix. */
  data: string
}

/**
 * How an attachment reaches the model. Not every file can be handed to a model
 * as itself: images and PDFs have native block types, anything textual can be
 * inlined, and the rest has no representation at all — so uploads of it are
 * refused at the door rather than silently dropped from the message.
 */
export type AttachmentKind = 'image' | 'document' | 'text'

/** The four the Anthropic API accepts. Notably absent: image/heic — an iPhone's
 * native photo format, which clients must transcode before upload. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/** Textual types whose media type doesn't start with `text/`. */
const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/x-httpd-php',
  'application/sql',
])

/** Strips any `; charset=…` parameter and lowercases. */
export const normalizeMediaType = (mediaType: string): string => {
  return mediaType.split(';')[0]!.trim().toLowerCase()
}

/** How this media type can be sent, or null if it can't be. */
export const attachmentKind = (mediaType: string): AttachmentKind | null => {
  const type = normalizeMediaType(mediaType)
  if (IMAGE_TYPES.has(type)) {
    return 'image'
  }
  if (type === 'application/pdf') {
    return 'document'
  }
  if (type.startsWith('text/') || TEXT_TYPES.has(type)) {
    return 'text'
  }
  return null
}

/** Human-readable list for the 415 an unsupported upload gets. */
export const SUPPORTED_ATTACHMENT_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/*'].join(', ')

/**
 * Anthropic content blocks for a set of attachments, in the given order.
 *
 * Blocks lead the message and the user's text follows: the model reads the
 * picture, then the instruction about it. Text files are inlined in a named
 * envelope rather than as a bare block, so "here is my config" doesn't read as
 * something the user typed.
 *
 * Structurally typed — `packages/core` models Anthropic content the way
 * `packages/protocol` does, and the caller casts into the SDK's own param type.
 */
export const attachmentContentBlocks = (attachments: readonly AttachmentInput[]): Array<Record<string, unknown>> => {
  return attachments.map((attachment) => {
    const mediaType = normalizeMediaType(attachment.mediaType)
    switch (attachmentKind(mediaType)) {
      case 'image': {
        return {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: attachment.data },
        }
      }
      case 'document': {
        return {
          type: 'document',
          source: { type: 'base64', media_type: mediaType, data: attachment.data },
          title: attachment.name,
        }
      }
      case 'text': {
        return {
          type: 'text',
          text: `<attachment name="${attachment.name}" type="${mediaType}">\n${decodeText(attachment.data)}\n</attachment>`,
        }
      }
      default: {
        throw new Error(`unsupported attachment media type: ${attachment.mediaType}`)
      }
    }
  })
}

/** Strip the bytes: the log-safe half of an attachment. */
export const attachmentRef = (attachment: AttachmentInput): MessageAttachment => {
  return {
    id: attachment.id,
    name: attachment.name,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
  }
}

const decodeText = (base64: string): string => {
  return Buffer.from(base64, 'base64').toString('utf8')
}
