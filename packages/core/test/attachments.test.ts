import { describe, expect, it } from 'vitest'
import { attachmentContentBlocks, attachmentKind, normalizeMediaType, type AttachmentInput } from '../src/lib/attachments.ts'

const input = (mediaType: string, data: string, name = 'thing'): AttachmentInput => ({
  id: 'a1',
  name,
  mediaType,
  bytes: Buffer.from(data, 'base64').length,
  data,
})

describe('attachmentKind', () => {
  it('accepts what the API can be shown, and nothing else', () => {
    expect(attachmentKind('image/png')).toBe('image')
    expect(attachmentKind('image/jpeg')).toBe('image')
    expect(attachmentKind('application/pdf')).toBe('document')
    expect(attachmentKind('text/markdown')).toBe('text')
    expect(attachmentKind('application/json')).toBe('text')
    // The one that matters most: an iPhone's own photo format is NOT accepted,
    // which is why clients transcode before uploading.
    expect(attachmentKind('image/heic')).toBeNull()
    expect(attachmentKind('application/octet-stream')).toBeNull()
    expect(attachmentKind('video/mp4')).toBeNull()
  })

  it('ignores media-type parameters and case', () => {
    expect(normalizeMediaType('Text/Plain; charset=UTF-8')).toBe('text/plain')
    expect(attachmentKind('IMAGE/PNG')).toBe('image')
  })
})

describe('attachmentContentBlocks', () => {
  it('builds an image block from base64, keeping the caller’s order', () => {
    expect(attachmentContentBlocks([input('image/png', 'AAA='), input('image/jpeg', 'BBB=')])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA=' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB=' } },
    ])
  })

  it('builds a titled document block for a PDF', () => {
    expect(attachmentContentBlocks([input('application/pdf', 'JVBE', 'memo.pdf')])).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' },
        title: 'memo.pdf',
      },
    ])
  })

  it('inlines text in a named envelope, so it does not read as typed input', () => {
    const data = Buffer.from('hello', 'utf8').toString('base64')
    expect(attachmentContentBlocks([input('text/plain', data, 'notes.txt')])).toEqual([
      { type: 'text', text: '<attachment name="notes.txt" type="text/plain">\nhello\n</attachment>' },
    ])
  })

  it('throws on a type it cannot represent rather than sending something else', () => {
    expect(() => attachmentContentBlocks([input('video/mp4', 'AAA=')])).toThrow(/unsupported attachment media type/)
  })
})
