import { useEffect, useState } from 'react'

import type { Region } from './types.ts'

export type Rect = { top: number; left: number; width: number; height: number }

export const REGION_ATTR = 'data-demo-region'

export const CARD_ATTR = 'data-demo-card'

export function resolveRegion(region: Region, root: ParentNode = document): Element[] {
  if (region.startsWith('css:')) {
    return [...root.querySelectorAll(region.slice('css:'.length))]
  }
  if (region.startsWith('card:')) {
    const marker = root.querySelector(`[${CARD_ATTR}="${CSS.escape(region.slice('card:'.length))}"]`)
    const card = marker?.closest('[data-slot="session-item"]')
    return card ? [card] : []
  }
  return [...root.querySelectorAll(`[${REGION_ATTR}="${CSS.escape(region)}"]`)]
}

export function measure(regions: readonly Region[], root: ParentNode = document): Rect | undefined {
  let top = Number.POSITIVE_INFINITY
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const region of regions) {
    for (const element of resolveRegion(region, root)) {
      const box = element.getBoundingClientRect()
      if (box.width === 0 && box.height === 0) {
        continue
      }
      top = Math.min(top, box.top)
      left = Math.min(left, box.left)
      right = Math.max(right, box.right)
      bottom = Math.max(bottom, box.bottom)
    }
  }
  if (!Number.isFinite(top)) {
    return undefined
  }
  return { top, left, width: right - left, height: bottom - top }
}

export function measureSelector(selector: string): Rect | undefined {
  const element = document.querySelector(selector)
  if (!element) {
    return undefined
  }
  const box = element.getBoundingClientRect()
  return { top: box.top, left: box.left, width: box.width, height: box.height }
}

// Panels animate and scroll under the overlay, so rects are re-read every frame while tracking, and state only moves when they change.
export function useTrackedRect(read: (() => Rect | undefined) | undefined): Rect | undefined {
  const [rect, setRect] = useState<Rect | undefined>(undefined)
  useEffect(() => {
    if (!read) {
      setRect(undefined)
      return
    }
    let frame = 0
    let last: Rect | undefined
    const tick = (): void => {
      const next = read()
      if (!sameRect(last, next)) {
        last = next
        setRect(next)
      }
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [read])
  return rect
}

export function inflate(rect: Rect, by: number): Rect {
  return { top: rect.top - by, left: rect.left - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}
