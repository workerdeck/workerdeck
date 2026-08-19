/**
 * `{basePath}/sessions/:id/events/:seq/result?toolUseId=` — the whole of a tool
 * result whose replay delivered only its head.
 *
 * **No new store.** The bytes are already in the runner's event log, which is
 * the same log the replay walked past; a second copy of a 641 KB result kept
 * "for fetching" would be exactly the cost this feature exists to remove.
 * `Runner.eventAt` is the read side of it.
 *
 * `toolUseId` is **required and verified against the block**, and that is not
 * belt-and-braces. A woken dormant session has a fresh log with fresh seqs, so
 * a `sourceSeq` a client cached before a gateway restart can name a completely
 * different event — and without the check the reader is handed another tool's
 * output under the row they pressed, silently. That is the exact bug class this
 * feature exists to remove, so it is refused rather than guessed at.
 *
 * The scope gate is the caller's (`/sessions/:id/*` is checked before this runs),
 * which is the whole authorization story here: visibility is full control.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SessionEvent, ToolResultBlock } from '@workerdeck/protocol'
import { json } from '../lib/http.ts'

/** How this route reaches the log: a live runner's `eventAt`, or a **parked**
 * snapshot's own events. A park keeps the log untruncated precisely so a
 * session read days later can still be read whole, so refusing one here would
 * break the case the design was careful to preserve. A *dormant* record holds no
 * log at all, so it resolves to `undefined` and 404s — the same answer `/files`
 * already gives it. */
export type EventLookup = ((seq: number) => SessionEvent | undefined) | undefined

export function handleToolResult(
  req: IncomingMessage,
  res: ServerResponse,
  lookup: EventLookup,
  seq: number,
): void {
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const toolUseId = new URL(req.url ?? '/', 'http://internal').searchParams.get('toolUseId')
  if (!toolUseId) {
    json(res, 400, { error: 'toolUseId is required' })
    return
  }
  // An engine that never truncates need not offer the log either — see
  // `Runner.eventAt`. 501 rather than 404: the session exists and the row the
  // reader pressed is real; it is this gateway's engine that cannot answer.
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
      candidate.type === 'tool_result' &&
      (candidate as ToolResultBlock).tool_use_id === toolUseId,
  )
  if (!block) {
    json(res, 404, { error: 'no such tool result in that event' })
    return
  }
  json(res, 200, { seq, toolUseId, content: block.content ?? '', isError: block.is_error === true })
}
