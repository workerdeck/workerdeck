import type { MessageAttachment } from '@workerdeck/protocol'

export type AttachmentInput = MessageAttachment & {
  data: string
}

export type AttachmentKind = 'image' | 'document' | 'text'

// The four the Anthropic API accepts; image/heic — what an iPhone shoots — is not one, and
// clients transcode before upload.
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

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

export const normalizeMediaType = (mediaType: string): string => {
  return mediaType.split(';')[0]!.trim().toLowerCase()
}

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

export const SUPPORTED_ATTACHMENT_TYPES = [...IMAGE_TYPES, 'application/pdf', 'text/*'].join(', ')

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
