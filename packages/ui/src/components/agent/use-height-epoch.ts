import { useEffect, useState, type RefObject } from 'react'
import { createHeightEpoch, measureCh, type HeightEpoch } from '../terminal/height.ts'

/**
 * One cache generation of computed row heights (terminal theme only). Measured
 * off the **rows container**, never the scroller: it is the width rows wrap in
 * and it inherits the surface's font, which is what makes the `ch` probe
 * honest. All DOM reads happen in the debounced effect; render never touches
 * layout.
 */
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
    if (!terminal) {
      return
    }
    const element = rowsRef.current
    if (!element) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(element).getPropertyValue('--term-line'))
      const width = element.clientWidth
      const ch = measureCh(element)
      if (!line || !width || !ch) {
        return
      }
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
    // fontSize/lineHeight re-arm the measurement directly: a transcript whose
    // container size survives a cell change never fires the observer.
  }, [terminal, fontSize, lineHeight, rowsRef])
  return epoch
}
