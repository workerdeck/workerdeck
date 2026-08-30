/**
 * `{basePath}/sessions/:id/events/:seq/result?toolUseId=` — the whole of a tool result whose
 * replay delivered only its head. **No new store**: the bytes are already in the runner's
 * event log, read back through `Runner.eventAt`.
 *
 * `toolUseId` is **required and verified against the block**. A woken dormant session has a
 * fresh log with fresh seqs, so a `sourceSeq` a client cached before a gateway restart can
 * name a completely different event — unchecked, the reader is silently handed another tool's
 * output under the row they pressed.
 *
 * The scope gate is the caller's (`/sessions/:id/*` runs before this).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { imagePartRef, type SessionEvent, type ToolResultBlock } from '@workerdeck/protocol'
import { json } from '../lib/http.ts'

/** How this route reaches the log: a live runner's `eventAt`, or a **parked** snapshot's own
 * events (a park keeps the log untruncated for exactly this). A *dormant* record holds no log,
 * so it resolves to `undefined` and 404s — the same answer `/files` gives it. */
export type EventLookup = ((seq: number) => SessionEvent | undefined) | undefined

export const handleToolResult = (req: IncomingMessage, res: ServerResponse, lookup: EventLookup, seq: number): void => {
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
  // 501 rather than 404: the session exists and the row the reader pressed is real; it is this
  // gateway's engine that does not offer the log (`Runner.eventAt` is optional).
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

  // `part=N` — one image part's bytes: the replay delivered an address, this answers it. Raw
  // bytes rather than JSON+base64, which would double the memory and put a decode on the
  // client's main thread.
  const partParam = url.searchParams.get('part')
  if (partParam !== null) {
    const index = Number(partParam)
    const parts = block.content
    const part = Number.isInteger(index) && Array.isArray(parts) ? parts[index] : undefined
    // Verified against the STORED block, never trusted from the query: the address was
    // stamped from this array and must still name a base64 image.
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

  // `imageRefs=1` projects the block's image parts through the same rule the replay used —
  // without it a "show everything" press against an image-bearing block ships every
  // screenshot's base64 inside the JSON. Default stays whole, for older clients.
  const content =
    url.searchParams.get('imageRefs') === '1' && Array.isArray(block.content)
      ? block.content.map((part, index) => imagePartRef(part, index) ?? part)
      : (block.content ?? '')
  json(res, 200, { seq, toolUseId, content, isError: block.is_error === true })
}
