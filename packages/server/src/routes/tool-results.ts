import type { IncomingMessage, ServerResponse } from 'node:http'
import { imagePartRef, type SessionEvent, type ToolResultBlock } from '@workerdeck/protocol'
import { json } from '../lib/http.ts'

export type EventLookup = ((seq: number) => SessionEvent | undefined) | undefined

export function handleToolResult(req: IncomingMessage, res: ServerResponse, lookup: EventLookup, seq: number): void {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://internal')
  const toolUseId = url.searchParams.get('toolUseId')
  if (!toolUseId) {
    json(res, 400, { error: 'toolUseId is required' })
    return
  }
  if (!lookup) {
    json(res, 501, { error: 'engine does not serve stored events' })
    return
  }
  const event = lookup(seq)
  if (!event || event.type !== 'user_message' || !Array.isArray(event.message.content)) {
    json(res, 404, { error: 'no such event' })
    return
  }
  const block = event.message.content.find(
    (candidate): candidate is ToolResultBlock =>
      candidate.type === 'tool_result' && (candidate as ToolResultBlock).tool_use_id === toolUseId,
  )
  if (!block) {
    json(res, 404, { error: 'no such tool result in that event' })
    return
  }

  const partParam = url.searchParams.get('part')
  if (partParam !== null) {
    const index = Number(partParam)
    const parts = block.content
    const part = Number.isInteger(index) && Array.isArray(parts) ? parts[index] : undefined
    const ref = part ? imagePartRef(part, index) : undefined
    if (!ref) {
      json(res, 404, { error: 'no such image part in that tool result' })
      return
    }
    const source = (part as { source?: { data?: string } }).source
    const bytes = Buffer.from(source?.data ?? '', 'base64')
    res.writeHead(200, { 'content-type': ref.media_type, 'content-length': String(bytes.length) })
    res.end(bytes)
    return
  }

  const content =
    url.searchParams.get('imageRefs') === '1' && Array.isArray(block.content)
      ? block.content.map((part, index) => imagePartRef(part, index) ?? part)
      : (block.content ?? '')
  json(res, 200, { seq, toolUseId, content, isError: block.is_error === true })
}
