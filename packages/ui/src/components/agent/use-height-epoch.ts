import { useEffect, useState, type RefObject } from 'react'
import { createHeightEpoch, measureCh, type HeightEpoch } from '../terminal/height.ts'

export const useHeightEpoch = (options: {
  terminal: boolean
  fontSize?: number
  lineHeight?: number
  rowsRef: RefObject<HTMLDivElement | null>
}): HeightEpoch | null => {
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
  }, [terminal, fontSize, lineHeight, rowsRef])
  return epoch
}
