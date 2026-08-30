import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '../../lib/utils.ts'

export interface SplitterProps {
  /**
   * ARIA's sense of the word: a `vertical` splitter is a vertical bar between two
   * side-by-side panes and resizes a **width**; `horizontal` resizes a **height**.
   */
  orientation: 'vertical' | 'horizontal'
  /** Current size of the pane this splitter controls, in pixels. */
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  /** Keyboard step. */
  step?: number
  /** Size to snap back to on a double-click; omit and a double-click does nothing. */
  defaultValue?: number
  /** Set when dragging the splitter *away* from the origin should shrink the
   * controlled pane — i.e. the pane is on the right or the bottom. */
  inverted?: boolean
  /** Required: "Resize" alone does not say which of two splitters this is. */
  'aria-label': string
  className?: string
}

/**
 * A draggable pane divider (hand-rolled — `@base-ui/react` ships no splitter).
 *
 * Pointer capture is what survives a fast drag: without it the pointer leaves the
 * 5px bar within a frame and the moves go to whatever is underneath. Moves are
 * measured against the pointerdown origin, not per-move deltas, so the pane cannot
 * drift from the cursor once clamping is involved.
 */
export function Splitter({
  orientation,
  value,
  onValueChange,
  min,
  max,
  step = 16,
  defaultValue,
  inverted,
  'aria-label': label,
  className,
}: SplitterProps) {
  const drag = useRef<{ origin: number; start: number } | null>(null)
  const vertical = orientation === 'vertical'

  const clamp = useCallback((next: number) => Math.min(max, Math.max(min, next)), [min, max])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Secondary buttons open context menus; they are not drags.
    if (event.button !== 0) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { origin: vertical ? event.clientX : event.clientY, start: value }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) {
      return
    }
    const delta = (vertical ? event.clientX : event.clientY) - state.origin
    onValueChange(clamp(state.start + (inverted ? -delta : delta)))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) {
      return
    }
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // The second click of a double-click has already started a drag, so the reset must
  // land after `endDrag` — it does: dblclick fires after pointerup.
  const onDoubleClick = () => {
    if (defaultValue !== undefined) {
      onValueChange(clamp(defaultValue))
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Only the arrows along this splitter's axis; the other pair is left to the page.
    const grow = vertical ? 'ArrowRight' : 'ArrowDown'
    const shrink = vertical ? 'ArrowLeft' : 'ArrowUp'
    const direction = inverted ? -1 : 1
    if (event.key === grow) {
      onValueChange(clamp(value + step * direction))
    } else if (event.key === shrink) {
      onValueChange(clamp(value - step * direction))
    } else if (event.key === 'Home') {
      onValueChange(min)
    } else if (event.key === 'End') {
      onValueChange(max)
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <div
      data-slot="splitter"
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      className={cn(
        // A 1px line that reads as a border, with a larger invisible grab area around it.
        'group relative shrink-0 touch-none bg-border transition-colors',
        'hover:bg-border-strong focus-visible:bg-accent focus-visible:outline-none',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}
    >
      <span aria-hidden className={cn('absolute', vertical ? '-inset-x-[3px] inset-y-0' : '-inset-y-[3px] inset-x-0')} />
    </div>
  )
}
