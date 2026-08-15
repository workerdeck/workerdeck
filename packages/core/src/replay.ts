import { replayCoalesceKey, type SessionEvent } from '@workerdeck/protocol'

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
