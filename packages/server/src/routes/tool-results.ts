import type { IncomingMessage, ServerResponse } from 'node:http'
import { imagePartRef, type SessionEvent, type ToolResultBlock } from '@workerdeck/protocol'
import { fail, json, requireMethod, untrustedDownloadHeaders } from '../lib/http.ts'

// The media type is whatever the tool claimed. Only rasters a browser cannot execute keep theirs; SVG and HTML never do.
const RASTER_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type EventLookup = ((seq: number) => SessionEvent | undefined) | undefined

export function handleToolResult(req: IncomingMessage, res: ServerResponse, lookup: EventLookup, seq: number): void {
  requireMethod(req, 'GET')
  const url = new URL(req.url ?? '/', 'http://internal')
  const toolUseId = url.searchParams.get('toolUseId')
  if (!toolUseId) {
    fail(400, 'toolUseId is required')
  }
  if (!lookup) {
    fail(501, 'engine does not serve stored events')
  }
  const event = lookup(seq)
  if (!event || event.type !== 'user_message' || !Array.isArray(event.message.content)) {
    fail(404, 'no such event')
  }
  const block = event.message.content.find(
    (candidate): candidate is ToolResultBlock =>
      candidate.type === 'tool_result' && (candidate as ToolResultBlock).tool_use_id === toolUseId,
  )
  if (!block) {
    fail(404, 'no such tool result in that event')
  }

  const partParam = url.searchParams.get('part')
  if (partParam !== null) {
    const index = Number(partParam)
    const parts = block.content
    const part = Number.isInteger(index) && Array.isArray(parts) ? parts[index] : undefined
    const ref = part ? imagePartRef(part, index) : undefined
    if (!ref) {
      fail(404, 'no such image part in that tool result')
    }
    const source = (part as { source?: { data?: string } }).source
    const bytes = Buffer.from(source?.data ?? '', 'base64')
    const mediaType = ref.media_type.split(';')[0]!.trim().toLowerCase()
    res.writeHead(200, {
      ...untrustedDownloadHeaders(
        `tool-result-${seq}-${index}`,
        RASTER_IMAGE_TYPES.has(mediaType) ? mediaType : 'application/octet-stream',
        bytes.length,
      ),
      'content-security-policy': "sandbox; default-src 'none'",
    })
    res.end(bytes)
    return
  }

  const content =
    url.searchParams.get('imageRefs') === '1' && Array.isArray(block.content)
      ? block.content.map((part, index) => imagePartRef(part, index) ?? part)
      : (block.content ?? '')
  json(res, 200, { seq, toolUseId, content, isError: block.is_error === true })
}
