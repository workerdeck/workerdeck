import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

const DRAG_SLOP = 4

/**
 * A row you can open, that you can also select text out of. Not a `<button>`:
 * the drag that selects text inside one ends in a `click`, so releasing the
 * mouse would collapse the block being highlighted. A `div` with the button
 * role and keyboard behaviour restored by hand, refusing the press when the
 * pointer travelled (a drag) or a selection is standing.
 */
export function Pressable({
  onPress,
  expanded,
  className,
  children,
}: {
  onPress: () => void
  /** Mirrored to `aria-expanded` when this press opens something. */
  expanded?: boolean
  className?: string
  children: ReactNode
}) {
  const origin = useRef<{ x: number; y: number } | null>(null)
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className={cn('term-press', className)}
      onPointerDown={(event) => {
        origin.current = { x: event.clientX, y: event.clientY }
      }}
      onClick={(event) => {
        const from = origin.current
        origin.current = null
        if (from && Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) > DRAG_SLOP) {
          return
        }
        // A selection inside this row is the tail of a drag the slop check may
        // have missed; a selection elsewhere on the page still reads as a click.
        const selection = window.getSelection?.()
        if (selection && !selection.isCollapsed && selection.containsNode(event.currentTarget, true)) {
          return
        }
        onPress()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return
        }
        event.preventDefault()
        onPress()
      }}
    >
      {children}
    </div>
  )
}

/**
 * Keep an expanding block's *first* line reachable: if the block now starts
 * above the fold, bring its first line back to the top edge. Deliberately
 * narrower than scroll-into-view (which would yank a block already fully in
 * view), one-directional, and only on the open transition — collapsing shrinks
 * toward its own top.
 */
export function useRevealOnOpen(open: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const previous = useRef(open)
  useEffect(() => {
    const opened = open && !previous.current
    previous.current = open
    if (!opened) {
      return
    }
    const element = ref.current
    if (!element) {
      return
    }
    // After paint: the new rows must be laid out and the virtualizer's
    // size-change correction run before an offset read means anything.
    const frame = requestAnimationFrame(() => {
      const scroller = scrollParent(element)
      if (!scroller) {
        return
      }
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      if (top >= scroller.scrollTop) {
        return
      }
      // One line of air, so the first row isn't flush against the scroller's edge.
      const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 0
      scroller.scrollTop = Math.max(0, top - line)
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
  return ref
}

/** The nearest ancestor that actually scrolls. */
const scrollParent = (from: HTMLElement): HTMLElement | null => {
  let node = from.parentElement
  while (node) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}
