import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../../lib/utils.ts'

/**
 * A row you can open, that you can also select text out of.
 *
 * A `<button>` cannot be both: text inside one is selectable in principle, but
 * the drag that selects it ends in a `click`, so releasing the mouse collapses
 * the very block you were highlighting — and the selection is discarded with it.
 * A transcript is *read* far more often than it is opened, so copying a command
 * out of a row has to win over the affordance that expands it.
 *
 * So: a `div` with the button role and the keyboard behaviour restored by hand,
 * and a press that is refused when the pointer travelled (a drag, not a click)
 * or when a selection is standing. Both checks are cheap and neither is a
 * heuristic about intent — a pointer that moved four pixels was dragging, and a
 * non-collapsed selection *is* the user having selected something.
 */
const DRAG_SLOP = 4

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
        // A click that merely *ends* a selection elsewhere on the page still
        // reads as a click; one that ends a selection inside this row is the
        // tail of a drag the slop check may have missed (a slow, short drag).
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
 * Keep an expanding block's *first* line reachable.
 *
 * A row that grows from one line to eighty pushes its own top off the screen:
 * the reader presses a summary and lands somewhere in the middle of what they
 * opened, with no clue that the beginning is above them. The fix is not a
 * scroll-into-view on every expand — that would yank a block already fully in
 * view — but the narrow one: if the block now starts above the fold, bring its
 * first line back to the top edge.
 *
 * Deliberately one-directional and only on the open transition. Collapsing needs
 * nothing (the block shrinks toward its own top, which is already on screen),
 * and a block whose top is already visible must not move at all.
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
    // After paint: the rows this block just grew by have to be laid out, and
    // the virtualizer's own size-change correction has to have run, before an
    // offset read here means anything.
    const frame = requestAnimationFrame(() => {
      const scroller = scrollParent(element)
      if (!scroller) {
        return
      }
      const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      if (top >= scroller.scrollTop) {
        return
      }
      // One line of air above it, so the first row isn't flush against the
      // scroller's edge — the same blank line every block gets.
      const line = Number.parseFloat(getComputedStyle(element).lineHeight) || 0
      scroller.scrollTop = Math.max(0, top - line)
    })
    return () => cancelAnimationFrame(frame)
  }, [open])
  return ref
}

/** The nearest ancestor that actually scrolls. */
function scrollParent(from: HTMLElement): HTMLElement | null {
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
