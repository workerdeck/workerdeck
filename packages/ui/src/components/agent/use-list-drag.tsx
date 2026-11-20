import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, HTMLAttributes, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { originSlot, sameSlot, sameTarget } from '../../lib/row-drag.ts'
import type { DragRow, DragRowKind, DragTarget, Slot } from '../../lib/row-drag.ts'

export type DragItem = { kind: 'session'; key: string; lead?: string } | { kind: 'group'; key: string }

export type DragGeometry = { rows: DragRow[]; team?: { top: number; bottom: number } }

export type ListDragOptions = {
  resolve: (item: DragItem, geometry: DragGeometry, y: number, current: DragTarget, origin: Slot) => DragTarget
  commit: (item: DragItem, target: DragTarget, origin: Slot) => void
}

type Active = DragItem & { height?: number; gap?: number; origin?: Slot; target?: DragTarget }

type Live = {
  item: DragItem
  grab: number
  clientY: number
  geometry: DragGeometry
  origin?: Slot
  target?: DragTarget
  box?: HTMLElement
  scroller?: HTMLElement
  frame?: number
  detach: () => void
}

// `zone` marks a card the dragged row hovers, or a drop the host refused; `badge` rides on the dragged row itself,
// which covers whatever it hovers.
export type DragCue = {
  zone?: 'join' | 'refused'
  message?: string
  badge?: { tone: 'accent' | 'danger'; join?: string; leave?: boolean; message?: string }
}

const THRESHOLD_PX = 4
const EDGE_PX = 40
const MAX_SCROLL_PX = 16
const FLIP_MS = 160
const ERROR_MS = 5000
const NO_DRAG = 'input, textarea, select, [contenteditable="true"], [data-no-drag]'

// Offsets ignore CSS transforms, so this is where a node sits even while it animates. `root` must be positioned.
function layoutTop(node: HTMLElement, root: HTMLElement): number {
  let top = 0
  let at: HTMLElement | null = node
  while (at && at !== root) {
    top += at.offsetTop
    at = at.offsetParent as HTMLElement | null
  }
  return top
}

function measure(root: HTMLElement): DragRow[] {
  return [...root.querySelectorAll<HTMLElement>('[data-drag-row]')]
    .filter((node) => node.offsetParent !== null)
    .map((node) => ({
      key: node.dataset.dragRow!,
      lane: node.dataset.dragLane!,
      kind: (node.dataset.dragKind ?? 'row') as DragRowKind,
      top: layoutTop(node, root),
      height: node.offsetHeight,
    }))
}

function dragRow(key: string, lane: string, kind: DragRowKind = 'row'): Record<`data-${string}`, string> {
  return { 'data-drag-row': key, 'data-drag-lane': lane, 'data-drag-kind': kind }
}

function scrollerOf(node: HTMLElement): HTMLElement | undefined {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && at.scrollHeight > at.clientHeight) {
      return at
    }
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : undefined
}

// Slides every node that moved from where it was, minus whatever its moving ancestor already carries.
function flip(root: HTMLElement, tops: Map<string, number>, animate: boolean): void {
  const moved = new Map<Element, number>()
  const seen = new Set<string>()
  for (const node of root.querySelectorAll<HTMLElement>('[data-drag-flip]')) {
    const key = node.dataset.dragFlip!
    const top = layoutTop(node, root)
    const before = tops.get(key)
    tops.set(key, top)
    seen.add(key)
    if (before === undefined || node.hasAttribute('data-drag-lifted')) {
      continue
    }
    const delta = before - top
    moved.set(node, delta)
    const ancestor = node.parentElement?.closest('[data-drag-flip]')
    const own = delta - (ancestor ? (moved.get(ancestor) ?? 0) : 0)
    if (animate && Math.abs(own) >= 0.5) {
      node.animate([{ transform: `translateY(${own}px)` }, { transform: 'translateY(0)' }], { duration: FLIP_MS, easing: 'ease-out' })
    }
  }
  for (const key of tops.keys()) {
    if (!seen.has(key)) {
      tops.delete(key)
    }
  }
}

function swallow(event: MouseEvent): void {
  event.stopPropagation()
  event.preventDefault()
}

function swallowNextClick(): void {
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

// Pointer-driven rather than HTML5 drag: the browser's drag image cannot be held to one axis, and the row itself
// should move. The lifted row follows the pointer vertically, a spacer marks where it lands and the rest slide.
export function useListDrag(options: ListDragOptions) {
  const root = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<Active>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  const live = useRef<Live>(undefined)
  const latest = useRef(options)
  const tops = useRef(new Map<string, number>())
  const failureTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useLayoutEffect(() => {
    latest.current = options
  })

  const place = () => {
    const state = live.current
    const node = root.current
    if (!state?.box || !node) {
      return 0
    }
    const y = state.clientY - node.getBoundingClientRect().top
    state.box.style.transform = `translateY(${y - state.grab - layoutTop(state.box, node)}px)`
    return y
  }

  const update = () => {
    const state = live.current
    const y = place()
    if (!state?.origin || !state.target) {
      return
    }
    const next = latest.current.resolve(state.item, state.geometry, y, state.target, state.origin)
    if (!sameTarget(next, state.target)) {
      state.target = next
      setActive((current) => current && { ...current, target: next })
    }
  }

  const finish = (commit: boolean) => {
    const state = live.current
    if (!state) {
      return
    }
    live.current = undefined
    state.detach()
    if (state.frame !== undefined) {
      cancelAnimationFrame(state.frame)
    }
    state.box?.style.removeProperty('transform')
    document.body.style.removeProperty('cursor')
    document.body.style.removeProperty('user-select')
    setActive(undefined)
    swallowNextClick()
    if (commit && state.target && state.origin) {
      latest.current.commit(state.item, state.target, state.origin)
    }
  }

  const begin = (item: DragItem, grab: number, clientY: number) => {
    const state: Live = {
      item,
      grab,
      clientY,
      geometry: { rows: [] },
      scroller: root.current ? scrollerOf(root.current) : undefined,
      detach: () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onCancel)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('scroll', onScroll, true)
      },
    }
    const onMove = (event: PointerEvent) => {
      state.clientY = event.clientY
      update()
    }
    const onUp = () => live.current === state && finish(true)
    const onCancel = () => live.current === state && finish(false)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && live.current === state) {
        event.preventDefault()
        event.stopPropagation()
        finish(false)
      }
    }
    const onScroll = () => live.current === state && update()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    const tick = () => {
      const scroller = state.scroller
      if (scroller && live.current === state) {
        const rect = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect()
        const push =
          state.clientY < rect.top + EDGE_PX
            ? -(rect.top + EDGE_PX - state.clientY)
            : state.clientY > rect.bottom - EDGE_PX
              ? state.clientY - (rect.bottom - EDGE_PX)
              : 0
        if (push !== 0) {
          scroller.scrollTop += Math.max(-MAX_SCROLL_PX, Math.min(MAX_SCROLL_PX, Math.round(push / 3)))
        }
      }
      if (live.current === state) {
        state.frame = requestAnimationFrame(tick)
      }
    }
    live.current = state
    state.frame = requestAnimationFrame(tick)
    window.getSelection()?.removeAllRanges()
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
    setActive({ ...item })
  }

  useLayoutEffect(() => {
    const state = live.current
    const node = root.current
    if (!active || !state || !node) {
      return
    }
    const lifted = node.querySelector<HTMLElement>(`[data-drag-box="${CSS.escape(active.key)}"]`)
    if (!lifted) {
      finish(false)
      return
    }
    state.box = lifted
    const rows = measure(node)
    const team =
      active.kind === 'session' && active.lead ? node.querySelector<HTMLElement>(`[data-drag-team="${CSS.escape(active.lead)}"]`) : null
    const teamTop = team ? layoutTop(team, node) : 0
    state.geometry = { rows, team: team ? { top: teamTop, bottom: teamTop + team.offsetHeight } : undefined }
    if (active.height === undefined) {
      const origin = originSlot(rows, active.key)
      if (!origin) {
        finish(false)
        return
      }
      const gap = lifted.parentElement ? Number.parseFloat(getComputedStyle(lifted.parentElement).rowGap) || 0 : 0
      state.origin = origin
      state.target = { slot: origin }
      tops.current.clear()
      flip(node, tops.current, false)
      place()
      setActive({ ...active, height: lifted.offsetHeight, gap, origin, target: state.target })
      return
    }
    flip(node, tops.current, true)
    place()
  })

  useEffect(
    () => () => {
      clearTimeout(failureTimer.current)
      finish(false)
    },
    [],
  )

  function grip(item: DragItem): HTMLAttributes<HTMLElement> {
    return {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0 || event.pointerType === 'touch' || live.current || (event.target as Element).closest(NO_DRAG)) {
          return
        }
        const owner = event.currentTarget.closest<HTMLElement>('[data-drag-box]')
        if (!owner) {
          return
        }
        event.stopPropagation()
        const startX = event.clientX
        const startY = event.clientY
        const grab = startY - owner.getBoundingClientRect().top
        const stop = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', stop)
          window.removeEventListener('pointercancel', stop)
        }
        const onMove = (move: PointerEvent) => {
          if (Math.hypot(move.clientX - startX, move.clientY - startY) >= THRESHOLD_PX) {
            stop()
            begin(item, grab, move.clientY)
          }
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', stop)
        window.addEventListener('pointercancel', stop)
      },
      onDragStart: (event) => event.preventDefault(),
    }
  }

  function box(key: string): HTMLAttributes<HTMLElement> & Record<`data-${string}`, string | undefined> {
    const lifted = active?.key === key && active.height !== undefined
    const style: CSSProperties | undefined = lifted
      ? { marginBottom: -(active.height! + (active.gap ?? 0)), position: 'relative', zIndex: 20, pointerEvents: 'none' }
      : undefined
    return {
      'data-drag-box': key,
      'data-drag-flip': key,
      'data-drag-lifted': lifted ? '' : undefined,
      style,
    }
  }

  function spacer(lane: string, before: string | undefined): ReactNode {
    if (active?.height === undefined || !active.target || !sameSlot(active.target.slot, { lane, before })) {
      return null
    }
    return <div aria-hidden data-drag-spacer="" style={{ height: active.height, flexShrink: 0 }} />
  }

  function cue(key: string): DragCue {
    const target = active?.target
    if (active?.key === key && target) {
      if (target.refusal) {
        return { badge: { tone: 'danger', message: target.refusal.message } }
      }
      if (target.join) {
        return { badge: { tone: 'accent', join: target.join } }
      }
      return target.leave ? { badge: { tone: 'accent', leave: true } } : {}
    }
    if (target?.refusal?.key === key) {
      return { zone: 'refused' }
    }
    if (failure?.key === key) {
      return { zone: 'refused', message: failure.message }
    }
    return target?.join === key ? { zone: 'join' } : {}
  }

  function fail(key: string, err: unknown): void {
    clearTimeout(failureTimer.current)
    setFailure({ key, message: err instanceof Error ? err.message : String(err) })
    failureTimer.current = setTimeout(() => setFailure(undefined), ERROR_MS)
  }

  return {
    root,
    active,
    lifted: (key: string) => active?.key === key && active.height !== undefined,
    grip,
    box,
    row: dragRow,
    spacer,
    cue,
    fail,
    clearFailure: () => setFailure(undefined),
  }
}

export type ListDrag = ReturnType<typeof useListDrag>
