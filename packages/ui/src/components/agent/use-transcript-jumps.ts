/**
 * The jump: aim at a virtual row, land exactly. Every jump on the transcript
 * surface — the catch-up strip's, and each of the scrubber's marks — comes
 * through here, along with the re-pin the catch-up strip's dismiss uses.
 * **Instant**, like everything else that moves the scroll position: VS Code's
 * editor jumps when you click its scrollbar and so does this.
 *
 * The aim loop survives from before the height calculator, with its job
 * changed twice. It used to be the mechanism: offsets over unmeasured spans
 * were sums of flat estimates (~3300px off over 600 rows), and the loop
 * walked them in up to six passes, each pass better than the last because
 * the rows it crossed had measured. With `estimateSize` computed the first
 * aim lands within a line or two; with the travel now instant there is also
 * no in-flight animation suppressing the virtualizer's own adjustments — the
 * condition that made a *single* smooth `scrollToIndex` unable to
 * self-correct at all. What is left is convergence insurance for the two
 * things the calculator cannot know: the recap row's estimated constant, and
 * flagged content (CJK, compressed tables). It is cheap now — each pass is a
 * jump, not a journey, so a pass that was already on target costs nothing and
 * the check exits after one.
 */
import { useEffect, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { useStickToBottomContext } from 'use-stick-to-bottom'
import type { HeightEpoch } from '../terminal/height.ts'
import { gapBefore, type TranscriptRow } from './transcript-rows.ts'

/** How many times a jump re-checks its landing, and how long it waits before
 * doing so. Both are much smaller than the smooth era's 6 × 300ms: a pass is
 * now a jump rather than a journey, so the only thing being waited on is a
 * layout pass in which the crossed rows measure. */
const AIM_PASSES = 4
const AIM_SETTLE_MS = 50

export function useTranscriptJumps(options: {
  rows: TranscriptRow[]
  terminal: boolean
  stickyPrompt: boolean
  epoch: HeightEpoch | null
  promptRows: readonly number[]
  scrollElement: HTMLElement | null
  rowsRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLElement, HTMLDivElement>
  stick: ReturnType<typeof useStickToBottomContext>
  jumpToRecapRef?: RefObject<(() => void) | null>
  repinRef?: RefObject<(() => void) | null>
}): (rowIndex: number, align?: 'start' | 'center') => void {
  const { rows, terminal, stickyPrompt, epoch, promptRows, scrollElement, rowsRef, virtualizer, stick, jumpToRecapRef, repinRef } = options

  // The pending re-aim lives in a ref, and this is the whole reason: the
  // closure is rebuilt every render to keep `rows` fresh, so anything held in
  // its scope is torn down every render too — and a jump in flight re-renders
  // constantly, because that is what rows mounting *is*. A timer in the
  // closure would be cancelled by the very work it is waiting for.
  const aimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(aimTimer.current), [])

  // `align` is the caller's, and every caller on this surface now asks for
  // `'start'`: a jump target is a place to *start reading* — what you came for
  // runs downward from it — so its line lands at exactly the top edge with the
  // screen below it to read into, and centring wastes half the viewport on what
  // you have already read. The recap boundary was the one exception, argued as
  // "a seam, and seeing a little of what came before is how you place it"; in
  // practice the seam is a starting line too. `'center'` survives as the
  // default because it is what `scrollIntoView` means and a future caller may
  // want it, not because anything here uses it.
  //
  // The two aligns aim differently, and the split is load-bearing. `'start'`
  // computes the target offset itself — never `scrollIntoView` — because a
  // prompt row is `position: sticky` and scrollIntoView aims at the element's
  // *current* rect, which for a stuck row is wherever it is pinned: the jump
  // would be a no-op on the very rows the scrubber's left lane points at. The
  // target is the row's virtual start plus the rows container's own offset in
  // the scroll content, plus the row's gap padding (the blank line is padding
  // *on* the row, and the reader asked for the line, not its air) — which also
  // lands exactly on the sticky engage threshold, so the row arrives pinned.
  // Re-aims recompute it while rows crossed by the travel measure.
  //
  // `stopScroll()` first, because the pin spring is the other `scrollTop`
  // writer and this is the library's own switch for "the user is leaving the
  // bottom".
  const jumpToRow = (rowIndex: number, align: 'start' | 'center' = 'center') => {
    if (rowIndex < 0 || rowIndex >= rows.length || !scrollElement) {
      return
    }
    stick.stopScroll()
    clearTimeout(aimTimer.current)
    if (align === 'start') {
      // The gap padding a row's *line* sits below — the target is the line,
      // not its air.
      const linePad = (index: number) => (terminal && epoch && index > 0 && gapBefore(rows, index) ? epoch.line : 0)
      const target = () => {
        const start = virtualizer.measurementsCache[rowIndex]?.start ?? 0
        const spacer = rowsRef.current
          ? rowsRef.current.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop
          : 0
        let top = start + spacer + linePad(rowIndex)
        // A non-prompt target lands *below* the pinned prompt, not under it:
        // at this offset the turn's own prompt head is stuck at the top, and a
        // jump that puts the line at zero puts it exactly behind that band —
        // the scrubber's answer marks would all land their first line hidden.
        // The head is one line tall. A jump *to* a prompt keeps zero: it
        // becomes the pinned row itself.
        if (terminal && stickyPrompt && epoch && !promptRows.includes(rowIndex)) {
          const pinned = promptRows.some((index) => index < rowIndex)
          if (pinned) {
            top -= epoch.line
          }
        }
        return Math.round(top)
      }
      const aim = (attempt: number) => {
        const top = target()
        scrollElement.scrollTo({ top, behavior: 'instant' })
        if (attempt >= AIM_PASSES) {
          return
        }
        aimTimer.current = setTimeout(() => {
          // Off target: a row that measured under the jump moved it. (It can no
          // longer be "still travelling" — that was the smooth era.)
          if (Math.abs(scrollElement.scrollTop - target()) > 1) {
            aim(attempt + 1)
          }
        }, AIM_SETTLE_MS)
      }
      aim(0)
      return
    }
    const aim = (attempt: number) => {
      const row = scrollElement.querySelector(`[data-index="${rowIndex}"]`)
      if (row) {
        row.scrollIntoView({ behavior: 'instant', block: align })
        return
      }
      if (attempt >= AIM_PASSES) {
        return
      }
      virtualizer.scrollToIndex(rowIndex, { align, behavior: 'auto' })
      // A frame or two, not a journey: the aim is only better once the rows
      // crossed have mounted *and* been measured, and that is a layout pass
      // away — but with the jump instant there is nothing else to wait for.
      aimTimer.current = setTimeout(() => aim(attempt + 1), AIM_SETTLE_MS)
    }
    aim(0)
  }

  useEffect(() => {
    if (!jumpToRecapRef) {
      return
    }
    jumpToRecapRef.current = () => {
      // `'start'`, like the scrubber's marks. The seam is a place to *start
      // reading* — everything you missed runs downward from it — so it belongs
      // at the top edge with the screen below it to read into. Centring it
      // spent half the viewport on rows you had already read.
      jumpToRow(
        rows.findIndex((row) => row.key === 'recap'),
        'start',
      )
    }
    return () => {
      jumpToRecapRef.current = null
    }
  })

  // Re-pin to the bottom. Published the same way as the jump above, and for the
  // same reason: only the scroll context can do it, and it lives in here.
  //
  // `'instant'`, never the follow spring. The spring exists to keep up with a
  // stream a few pixels at a time; from a reader who had scrolled a long way up
  // it would animate the whole way down, which is the smooth-scroll-on-switch
  // complaint this component already carries two guards against. The target is
  // trustworthy because the bottom is `totalSize`, which the height calculator
  // makes exact — unlike a mid-list row, which is why `jumpToRow` needs its
  // aim/re-aim loop and this needs none.
  useEffect(() => {
    if (!repinRef) {
      return
    }
    repinRef.current = () => {
      void stick.scrollToBottom('instant')
    }
    return () => {
      repinRef.current = null
    }
  })

  return jumpToRow
}
