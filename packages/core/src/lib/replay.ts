import {
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
 * 4. `truncateResults` — a huge `tool_result` block is delivered as its head
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
  },
): SessionEvent[] {
  const { afterSeq, resetSeq = 0, coalesceReplay, truncateResults } = options
  const stale = coalesceReplay ? staleReplaySeqs(events, afterSeq) : undefined
  const lastSeq = events[events.length - 1]?.seq ?? 0
  const out: SessionEvent[] = []
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.seq < resetSeq && transcriptContent(event)) continue
    if (stale?.has(event.seq)) continue
    if (coalesceReplay && event.seq !== lastSeq && !replayRetains(event)) continue
    out.push(truncateResults ? truncateResultBlocks(event) : event)
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
    if (typeof part.text !== 'string') continue
    if (used >= chars) break
    const text = part.text.slice(0, chars - used)
    parts.push({ ...part, text })
    used += text.length + 1
  }
  return parts
}
