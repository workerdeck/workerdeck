import { useEffect, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { useStickToBottomContext } from 'use-stick-to-bottom'
import type { HeightEpoch } from '../terminal/height.ts'
import { gapBefore, type TranscriptRow } from './transcript-rows.ts'

/** How many times a jump re-checks its landing, and how long it waits. A pass
 * is a jump rather than a journey, so the only thing waited on is a layout pass
 * in which the crossed rows measure. */
const AIM_PASSES = 4
const AIM_SETTLE_MS = 50

/**
 * Aim at a virtual row and land exactly. Every jump on the transcript surface
 * comes through here, along with the re-pin the catch-up strip's dismiss uses.
 * **Instant**, like everything else that moves the scroll position.
 *
 * The aim loop is convergence insurance for the two things the height
 * calculator cannot know: the recap row's estimated constant, and flagged
 * content (CJK, compressed tables).
 */
export const useTranscriptJumps = (options: {
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
}): ((rowIndex: number, align?: 'start' | 'center') => void) => {
  const { rows, terminal, stickyPrompt, epoch, promptRows, scrollElement, rowsRef, virtualizer, stick, jumpToRecapRef, repinRef } = options

  // The pending re-aim must live in a ref: the closure is rebuilt every render
  // to keep `rows` fresh, and a jump in flight re-renders constantly, so a
  // timer in the closure would be cancelled by the work it is waiting for.
  const aimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(aimTimer.current), [])

  // The two aligns aim differently, and the split is load-bearing. `'start'`
  // computes the target offset itself — **never `scrollIntoView`** — because a
  // prompt row is `position: sticky` and scrollIntoView aims at the element's
  // *current* rect, which for a stuck row is wherever it is pinned: the jump
  // would be a no-op on the very rows the scrubber's left lane points at. The
  // target is the row's virtual start plus the rows container's offset in the
  // scroll content plus the row's gap padding, which also lands exactly on the
  // sticky engage threshold, so the row arrives pinned.
  //
  // `stopScroll()` first, because the pin spring is the other `scrollTop`
  // writer and this is the library's switch for "the user is leaving the bottom".
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
        // A non-prompt target lands *below* the pinned prompt (one line tall),
        // or its first line would be hidden behind the stuck band. A jump *to*
        // a prompt keeps zero: it becomes the pinned row itself.
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
          // Off target: a row that measured under the jump moved it.
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
      // A frame or two: the aim is only better once the crossed rows have
      // mounted *and* measured, which is a layout pass away.
      aimTimer.current = setTimeout(() => aim(attempt + 1), AIM_SETTLE_MS)
    }
    aim(0)
  }

  useEffect(() => {
    if (!jumpToRecapRef) {
      return
    }
    jumpToRecapRef.current = () => {
      // `'start'`, like the scrubber's marks: the seam is a place to start
      // reading, so it belongs at the top edge.
      jumpToRow(
        rows.findIndex((row) => row.key === 'recap'),
        'start',
      )
    }
    return () => {
      jumpToRecapRef.current = null
    }
  })

  // Re-pin to the bottom: `'instant'`, never the follow spring, which exists to
  // keep up with a stream a few pixels at a time and would animate the whole way
  // down from a reader far up. No aim loop needed — the bottom is `totalSize`,
  // which the height calculator makes exact.
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
