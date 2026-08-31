import { useEffect, useRef, type RefObject } from 'react'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { useStickToBottomContext } from 'use-stick-to-bottom'
import type { HeightEpoch } from '../terminal/height.ts'
import { gapBefore, type TranscriptRow } from './transcript-rows.ts'

const AIM_PASSES = 4
const AIM_SETTLE_MS = 50

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
      void stick.scrollToBottom('instant')
    }
    return () => {
      repinRef.current = null
    }
  })

  return jumpToRow
}
