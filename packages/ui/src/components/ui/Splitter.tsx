import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { cn } from '../../lib/utils.ts'

export interface SplitterProps {
  /**
   * ARIA's sense of the word: a `vertical` splitter is a vertical bar between
   * two side-by-side panes, and it resizes a **width**. A `horizontal` one sits
   * between stacked panes and resizes a **height**.
   */
  orientation: 'vertical' | 'horizontal'
  /** Current size of the pane this splitter controls, in pixels. */
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  /** Keyboard step. */
  step?: number
  /**
   * Size to snap back to on a double-click — the convention every pane divider
   * that can be dragged is expected to honour. Omit and a double-click does
   * nothing, which is the honest behaviour when there is no default to mean.
   */
  defaultValue?: number
  /** Set when dragging the splitter *away* from the origin should shrink the
   * controlled pane — i.e. the pane is on the right or the bottom. */
  inverted?: boolean
  /** Required: "Resize" alone does not say which of two splitters this is. */
  'aria-label': string
  className?: string
}

/**
 * A draggable pane divider.
 *
 * Hand-rolled rather than depended on: `@base-ui/react` ships no splitter, the
 * behaviour is a hundred lines of pointer events, and this repo's instinct at
 * this layer is to own it (the composer is vendored for the same reason).
 *
 * Pointer capture is what makes it survive a fast drag — without it the pointer
 * leaves the 5px bar within a frame and the moves go to whatever is underneath,
 * which for this layout is an iframe-free but still selection-happy code pane.
 * The drag origin is captured on pointerdown and every move is measured against
 * it, so the pane cannot drift relative to the cursor over a long drag the way
 * per-move deltas do once clamping is involved.
 *
 * Keyboard-operable and announced as a separator, because a pane you can only
 * size by dragging is a pane some people cannot size.
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
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { origin: vertical ? event.clientX : event.clientY, start: value }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state) return
    const delta = (vertical ? event.clientX : event.clientY) - state.origin
    onValueChange(clamp(state.start + (inverted ? -delta : delta)))
  }

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // The second click of a double-click has already started a drag, so the reset
  // has to land after `endDrag` — which it does: dblclick fires after pointerup.
  const onDoubleClick = () => {
    if (defaultValue !== undefined) onValueChange(clamp(defaultValue))
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // The arrows that move *along* this splitter's axis of travel; the other
    // pair is left to the page, which is what a separator should do with them.
    const grow = vertical ? 'ArrowRight' : 'ArrowDown'
    const shrink = vertical ? 'ArrowLeft' : 'ArrowUp'
    const direction = inverted ? -1 : 1
    if (event.key === grow) onValueChange(clamp(value + step * direction))
    else if (event.key === shrink) onValueChange(clamp(value - step * direction))
    else if (event.key === 'Home') onValueChange(min)
    else if (event.key === 'End') onValueChange(max)
    else return
    event.preventDefault()
  }

  return (
    <div
      data-slot='splitter'
      role='separator'
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
        // A 1px line that reads as a border, with a larger invisible grab area
        // around it — a hairline is an honest divider and a cruel target.
        'group relative shrink-0 touch-none bg-border transition-colors',
        'hover:bg-border-strong focus-visible:bg-accent focus-visible:outline-none',
        vertical ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}>
      <span
        aria-hidden
        className={cn(
          'absolute',
          vertical ? '-inset-x-[3px] inset-y-0' : '-inset-y-[3px] inset-x-0',
        )}
      />
    </div>
  )
}
