/**
 * The height epoch: one cache generation of computed row heights (terminal
 * theme only — cards have no calculator and keep the flat estimate). Owned by
 * the transcript shell because it owns the virtualizer the heights feed; the
 * WeakMap inside self-invalidates through the reducer's replace-on-mutation,
 * and the epoch itself is replaced wholesale when the wrap width or the cell
 * changes. Measured off the rows container: it *is* the width rows wrap in
 * (the scroller can resize without it moving — `ConversationContent` caps at
 * 48rem — and the window never hears about a splitter drag), and it inherits
 * the surface's font, which is what makes the `ch` probe honest. All DOM
 * reads happen in the effect, debounced; render never touches layout.
 */
import { useEffect, useState, type RefObject } from 'react'
import { createHeightEpoch, measureCh, type HeightEpoch } from '../terminal/height.ts'

export function useHeightEpoch(options: {
  terminal: boolean
  /** The terminal cell, when the host set one — only read as a signal that the
   * epoch must re-measure; the epoch's numbers come from the DOM. */
  fontSize?: number
  lineHeight?: number
  rowsRef: RefObject<HTMLDivElement | null>
}): HeightEpoch | null {
  const { terminal, fontSize, lineHeight, rowsRef } = options
  const [epoch, setEpoch] = useState<HeightEpoch | null>(null)
  useEffect(() => {
    if (!terminal) return
    const element = rowsRef.current
    if (!element) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const line = Number.parseFloat(
        getComputedStyle(element).getPropertyValue('--term-line'),
      )
      const width = element.clientWidth
      const ch = measureCh(element)
      if (!line || !width || !ch) return
      setEpoch((previous) =>
        previous && previous.width === width && previous.ch === ch && previous.line === line
          ? previous
          : createHeightEpoch(width, ch, line),
      )
    }
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(measure, 150)
    })
    observer.observe(element)
    measure()
    return () => {
      observer.disconnect()
      clearTimeout(timer)
    }
    // fontSize/lineHeight: a cell change re-renders every row, which usually
    // moves the container's size and fires the observer — but a transcript
    // whose height happens to survive the change would keep a stale `ch`, so
    // the props re-arm the measurement directly.
  }, [terminal, fontSize, lineHeight, rowsRef])
  return epoch
}
