import { useEffect, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { useStickToBottomContext } from 'use-stick-to-bottom'
import type { HeightEpoch } from '../terminal/height.ts'
import { gapBefore, type TranscriptRow } from './transcript-rows.ts'

const AIM_PASSES = 4
const AIM_SETTLE_MS = 50

// How long a send's re-pin outlasts the click — long enough to eat a trackpad's momentum tail.
export const REPIN_HOLD_MS = 750

type RepinTarget = Pick<ReturnType<typeof useStickToBottomContext>, 'scrollToBottom' | 'state'>

// The send re-pin: a held, escape-proof pin, not one `scrollToBottom('instant')` — a trackpad's
// trailing momentum tick reads as escape intent and aborts the one-shot before its first frame
// (GOTCHAS "The send re-pin is a held pin"). Every line is load-bearing: clear the stale escape
// flag, hold through the momentum tail, seed the `ignoreEscapes` record the library only
// installs one rAF too late, and press the first scroll synchronously. Deliberate detach
// (`stopScroll`, drag-selection) still wins immediately.
export function repinToBottom(stick: RepinTarget): void {
  const { state } = stick
  state.escapedFromLock = false
  const settled = stick.scrollToBottom({ animation: 'instant', ignoreEscapes: true, duration: REPIN_HOLD_MS })
  state.animation = { behavior: 'instant', ignoreEscapes: true, promise: Promise.resolve(settled) }
  state.scrollTop = state.calculatedTargetScrollTop
}

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

  const aimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(aimTimer.current), [])

  const jumpToRow = (rowIndex: number, align: 'start' | 'center' = 'center') => {
    if (rowIndex < 0 || rowIndex >= rows.length || !scrollElement) {
      return
    }
    stick.stopScroll()
    clearTimeout(aimTimer.current)
    // `'start'` computes the offset itself, never `scrollIntoView`: a prompt row is `position: sticky`, and while stuck its current rect is where it is pinned, so the jump would no-op on exactly the rows the scrubber's left lane points at.
    if (align === 'start') {
      const linePad = (index: number) => (terminal && epoch && index > 0 && gapBefore(rows, index) ? epoch.line : 0)
      const target = () => {
        const start = virtualizer.measurementsCache[rowIndex]?.start ?? 0
        const spacer = rowsRef.current
          ? rowsRef.current.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop
          : 0
        let top = start + spacer + linePad(rowIndex)
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
      aimTimer.current = setTimeout(() => aim(attempt + 1), AIM_SETTLE_MS)
    }
    aim(0)
  }

  useEffect(() => {
    if (!jumpToRecapRef) {
      return
    }
    jumpToRecapRef.current = () => {
      jumpToRow(
        rows.findIndex((row) => row.key === 'recap'),
        'start',
      )
    }
    return () => {
      jumpToRecapRef.current = null
    }
  })

  useEffect(() => {
    if (!repinRef) {
      return
    }
    repinRef.current = () => {
      // A pending jump's re-aim would land after the re-pin and yank the view back up.
      clearTimeout(aimTimer.current)
      repinToBottom(stick)
    }
    return () => {
      repinRef.current = null
    }
  })

  return jumpToRow
}
