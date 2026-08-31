import { useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { cn } from '../../lib/utils.ts'

export interface SplitterProps {
  orientation: 'vertical' | 'horizontal'
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  step?: number
  defaultValue?: number
  inverted?: boolean
  'aria-label': string
  className?: string
}

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

  // Reached after `endDrag` — the second click of a double-click has already started a drag, and dblclick fires after pointerup.
  const onDoubleClick = () => {
    if (defaultValue !== undefined) {
      onValueChange(clamp(defaultValue))
    }
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
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
