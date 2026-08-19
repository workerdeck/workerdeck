import {
  imagePartRef,
  replayCoalesceKey,
  replayRetains,
  TOOL_RESULT_HEAD_CHARS,
  transcriptContent,
  type SessionEvent,
  type ToolResultBlock,
} from '@workerdeck/protocol'

/**
 * Which buffered events a coalesced replay should skip: everything superseded
 * by a later event with the same {@link replayCoalesceKey}.
 *
 * A **backwards** scan, keeping the first occurrence of each key — which is the
 * whole trick. Walking forwards would need a second pass to know which of the
 * fifty context readings was the last one; walking backwards, the first one you
 * meet *is* the last one, and everything after it (in scan order) is history.
 *
 * Note what this does **not** do: it never reorders and never touches an event
 * with no key. Transcript content is an ordered fold — a stream delta
 * accumulates onto a message, a tool result attaches to a call that came
 * earlier, a turn result finalizes — so it must arrive exactly as it was
 * emitted. Only last-write-wins *state* is eligible, and `replayCoalesceKey`
 * is where that judgement lives.
 *
 * `afterSeq` is honoured so the scan agrees with the caller's replay window: an
 * event the caller was never going to send must not suppress one it was.
 */
export function staleReplaySeqs(events: readonly SessionEvent[], afterSeq: number): Set<number> {
  const stale = new Set<number>()
  const seen = new Set<string>()
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (event.seq <= afterSeq) break
    const key = replayCoalesceKey(event)
    if (key === undefined) continue
    if (seen.has(key)) stale.add(event.seq)
    else seen.add(key)
  }
  return stale
}

/**
 * The one replay body, and what a socket receives from it.
 *
 * Every runner had a byte-identical copy of this loop — three spellings of four
 * rules, one of which ("never drop the highest-seq event, whatever the rule
 * says") is load-bearing and was three copies of a comment. Not a base class:
 * the runners share nothing else, and a base class would have to own `#emit`,
 * the most engine-specific method each of them has.
 *
 * The rules, in the order they are applied:
 *
 * 1. `afterSeq` — the caller already holds everything at or below it.
 * 2. `resetSeq` — transcript *content* strictly below the latest
 *    `conversation_reset` is skipped, so a re-attach cannot resurrect a cleared
 *    conversation while state events still replay. Claude's alone; the other
 *    engines pass 0.
 * 3. `coalesceReplay` — last-write-wins state readings superseded later in the
 *    same replay (`staleReplaySeqs`), plus everything `replayRetains` says the
 *    reducer reads and discards. Opt-in, and only sound for a consumer whose
 *    handling of those events is last-write-wins.
 * 4. `imageRefs` — a base64 image part is delivered as an `image_ref` address
 *    (protocol's {@link imagePartRef}), its bytes one REST fetch away. Applied
 *    **before** rule 5, because it stamps indices from the stored part array
 *    which rule 5 then reshapes. Unlike rule 5 this also applies to the live
 *    path (see `SubscriberSet`), which is the one place these two rules differ.
 * 5. `truncateResults` — a huge `tool_result` block is delivered as its head
 *    plus the markers that say so. **Never mutates the stored event**: the live
 *    path, the parking snapshot and the fetch route all need the whole thing,
 *    so this builds a copy and the log stays the log.
 *
 * The highest-seq event is delivered whatever rules 2 and 3 say — a client's
 * replay hold waits for `state.lastSeq` to reach the attach's and would
 * otherwise hang forever — but it is still *truncated* when rule 4 applies. A
 * session that ends on a `find /` puts its 641 KB frame exactly there.
 */
export function replaySlice(
  events: readonly SessionEvent[],
  options: {
    afterSeq: number
    resetSeq?: number
    coalesceReplay?: boolean
    truncateResults?: boolean
    imageRefs?: boolean
  },
): SessionEvent[] {
  const { afterSeq, resetSeq = 0, coalesceReplay, truncateResults, imageRefs } = options
  const stale = coalesceReplay ? staleReplaySeqs(events, afterSeq) : undefined
  const lastSeq = events[events.length - 1]?.seq ?? 0
  const out: SessionEvent[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.seq < resetSeq && transcriptContent(event)) continue
    if (stale?.has(event.seq)) continue
    if (coalesceReplay && event.seq !== lastSeq && !replayRetains(event)) continue
    // Refs before heads, always: `refImageParts` stamps addresses from the
    // stored part array and `truncateResultBlocks` reshapes it.
    let delivered = event
    if (imageRefs) delivered = refImageParts(delivered)
    if (truncateResults) delivered = truncateResultBlocks(delivered)
    out.push(delivered)
  }
  return out
}

/**
 * A copy of `event` whose oversized `tool_result` blocks carry their head and
 * say so — or `event` itself, unchanged and un-copied, when nothing is over the
 * budget. That identity matters: an attach is mostly small events, and a fresh
 * object for every one of them would cost more than the feature saves.
 *
 * Blocks are measured and cut **individually**. A message answering three calls
 * where one is a `find /` keeps the two small results whole, which is what makes
 * the per-block marker (rather than a per-event one) honest.
 */
export function truncateResultBlocks(event: SessionEvent): SessionEvent {
  if (event.type !== 'user_message') return event
  const content = event.message.content
  if (!Array.isArray(content)) return event
  let cut = false
  const blocks = content.map((block) => {
    if (block.type !== 'tool_result') return block
    const result = block as ToolResultBlock
    if (result.truncated) return block
    const total = resultChars(result.content)
    if (total <= TOOL_RESULT_HEAD_CHARS) return block
    cut = true
    return {
      ...result,
      content: headOf(result.content, TOOL_RESULT_HEAD_CHARS),
      truncated: true,
      total_chars: total,
    } satisfies ToolResultBlock
  })
  if (!cut) return event
  return { ...event, message: { ...event.message, content: blocks } }
}

/** Characters in a result's content, in the same terms a reader sees it: the
 * string itself, or every text part of a block list joined by newlines — which
 * is exactly what `blockText` in the reducer builds. Non-text parts (an image
 * block) contribute nothing, because they are not what is large here and
 * slicing them would corrupt them. */
function resultChars(content: ToolResultBlock['content']): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce(
    (total, part, index) =>
      total + (typeof part.text === 'string' ? part.text.length + (index > 0 ? 1 : 0) : 0),
    0,
  )
}

/** The first `chars` characters, in the content's own shape — a string stays a
 * string, a block list stays a block list (cut at the part that crosses the
 * budget, with the remaining parts dropped). Shape-preserving on purpose: the
 * reducer, both renderers and the copy button all read this the same way they
 * read a whole one, so truncation is a shorter result and never a different
 * kind of one. */
function headOf(content: ToolResultBlock['content'], chars: number): ToolResultBlock['content'] {
  if (typeof content === 'string') return content.slice(0, chars)
  if (!Array.isArray(content)) return content
  const parts: Array<{ type: string; text?: string; [key: string]: unknown }> = []
  let used = 0
  for (const part of content) {
    // An address this gateway itself just minted (`refImageParts` runs first).
    // Keeping it is what lets the two rules compose: dropped here, a socket
    // asking for both heads and refs would lose every picture with no marker.
    // Raw `image` parts keep being dropped exactly as Part 4 shipped them,
    // which is what keeps a truncate-only socket byte-identical.
    if (part.type === 'image_ref') {
      parts.push(part)
      continue
    }
    if (typeof part.text !== 'string') continue
    // `continue`, not `break`: an exhausted text budget must not strand the
    // refs that come after it. Identical output for text either way.
    if (used >= chars) continue
    const text = part.text.slice(0, chars - used)
    parts.push({ ...part, text })
    used += text.length + 1
  }
  return parts
}

/**
 * A copy of `event` whose `tool_result` blocks carry `image_ref` addresses in
 * place of their base64 image parts — or `event` itself, unchanged and
 * un-copied, when it holds none. Same identity rule as
 * {@link truncateResultBlocks}, and it matters more here: an event carrying an
 * image at all is the exception, so the common path must not allocate.
 *
 * **Never mutates the stored event.** The log is what the parking snapshot
 * embeds, what `Runner.eventAt` reads, and therefore what the fetch route
 * serves the bytes back from — a drop that reached the log would 404 the very
 * lazy-load this rule promises.
 *
 * Indices are stamped from the **stored** array, which is why this runs *before*
 * truncation rather than after: `headOf` reshapes a block's parts, so an address
 * computed on its output would name the wrong part of the stored block. That
 * ordering is asserted in `replay-image-ref.test.ts`, not merely intended.
 */
export function refImageParts(event: SessionEvent): SessionEvent {
  if (event.type !== 'user_message') return event
  const content = event.message.content
  if (!Array.isArray(content)) return event
  let changed = false
  const blocks = content.map((block) => {
    if (block.type !== 'tool_result') return block
    const result = block as ToolResultBlock
    const parts = result.content
    if (!Array.isArray(parts)) return block
    let blockChanged = false
    const mapped = parts.map((part, index) => {
      const ref = imagePartRef(part, index)
      if (!ref) return part
      blockChanged = true
      return ref
    })
    if (!blockChanged) return block
    changed = true
    return { ...result, content: mapped } satisfies ToolResultBlock
  })
  if (!changed) return event
  return { ...event, message: { ...event.message, content: blocks } }
}
