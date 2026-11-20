import { orderedGroupBy } from '@workerdeck/protocol'
import type { SessionGroup, ViewConfig } from '@workerdeck/protocol'
import { dropZone } from './team-drop.ts'

// `pinned` is a row nothing may land after (Ungrouped, Earlier); `empty` is an empty custom group's drop box.
export type DragRowKind = 'row' | 'heading' | 'empty' | 'pinned'

export type DragRow = { key: string; lane: string; kind: DragRowKind; top: number; height: number }

export type Slot = { lane: string; before?: string }

export type DragTarget = { slot: Slot; join?: string; leave?: boolean; refusal?: { key: string; message: string } }

export type SessionDragContext = {
  dragged: string
  origin: Slot
  reorder: boolean
  // `true` joins the target's team, a string is why it may not, undefined when the target leads no team at all.
  joinable: (target: string) => true | string | undefined
  // Set for a member: its team's lane, its lead's row and the vertical extent of the team's block.
  team?: { lane: string; lead: string; leadLane: string; top: number; bottom: number }
}

export function sameSlot(a: Slot, b: Slot): boolean {
  return a.lane === b.lane && a.before === b.before
}

export function sameTarget(a: DragTarget, b: DragTarget): boolean {
  return (
    sameSlot(a.slot, b.slot) &&
    a.join === b.join &&
    a.leave === b.leave &&
    a.refusal?.key === b.refusal?.key &&
    a.refusal?.message === b.refusal?.message
  )
}

// Past either end of the list counts as the first or the last row, so the very top and bottom stay reachable.
function hitAt(rows: readonly DragRow[], y: number, dragged: string): DragRow | undefined {
  const others = rows.filter((row) => row.key !== dragged)
  const first = others.reduce<DragRow | undefined>((best, row) => (!best || row.top < best.top ? row : best), undefined)
  const last = others.reduce<DragRow | undefined>((best, row) => (!best || row.top + row.height > best.top + best.height ? row : best), undefined)
  if (first && y < first.top) {
    return first
  }
  if (last && y >= last.top + last.height) {
    return last
  }
  return others.find((row) => y >= row.top && y < row.top + row.height)
}

function laneRows(rows: readonly DragRow[], lane: string, dragged: string): DragRow[] {
  return rows.filter((row) => row.lane === lane && row.key !== dragged && (row.kind === 'row' || row.kind === 'pinned'))
}

function nextIn(rows: readonly DragRow[], hit: DragRow, dragged: string): string | undefined {
  const lane = laneRows(rows, hit.lane, dragged)
  return lane[lane.indexOf(hit) + 1]?.key
}

function firstIn(rows: readonly DragRow[], lane: string, dragged: string): string | undefined {
  return laneRows(rows, lane, dragged)[0]?.key
}

export function originSlot(rows: readonly DragRow[], key: string): Slot | undefined {
  const self = rows.find((row) => row.key === key)
  if (!self) {
    return undefined
  }
  const lane = rows.filter((row) => row.lane === self.lane && (row.kind === 'row' || row.kind === 'pinned'))
  return { lane: self.lane, before: lane[lane.indexOf(self) + 1]?.key }
}

function halves(rows: readonly DragRow[], hit: DragRow, y: number, dragged: string): Slot {
  if (hit.kind === 'pinned') {
    return { lane: hit.lane, before: hit.key }
  }
  const upper = y < hit.top + hit.height / 2
  return { lane: hit.lane, before: upper ? hit.key : nextIn(rows, hit, dragged) }
}

// Hit-testing runs against layout positions, never the animated ones, and a pointer over no row (the gap the
// dragged row left, or space between groups) keeps the last answer, so moving the gap can never flip it back.
export function sessionTarget(rows: readonly DragRow[], y: number, current: DragTarget, ctx: SessionDragContext): DragTarget {
  const hit = hitAt(rows, y, ctx.dragged)
  const team = ctx.team
  if (team) {
    const leaveAt = (row: DragRow, slot: Slot): DragTarget =>
      ctx.reorder ? { slot: row.kind === 'empty' ? { lane: row.lane } : slot, leave: true } : { slot: ctx.origin, leave: true }
    if (y >= team.top && y < team.bottom) {
      if (!hit) {
        return current
      }
      if (hit.lane === team.lane) {
        return { slot: halves(rows, hit, y, ctx.dragged) }
      }
      if (hit.key === team.lead) {
        return dropZone(y - hit.top, hit.height) === 'before'
          ? leaveAt(hit, { lane: hit.lane, before: hit.key })
          : { slot: { lane: team.lane, before: firstIn(rows, team.lane, ctx.dragged) } }
      }
      return current
    }
    if (!hit) {
      if (current.leave) {
        return current
      }
      const lead = rows.find((row) => row.key === team.lead)
      return ctx.reorder && lead
        ? { slot: { lane: team.leadLane, before: nextIn(rows, lead, ctx.dragged) }, leave: true }
        : { slot: ctx.origin, leave: true }
    }
    if (hit.kind === 'heading') {
      return leaveAt(hit, { lane: hit.lane, before: firstIn(rows, hit.lane, ctx.dragged) })
    }
    if (hit.kind === 'row' && dropZone(y - hit.top, hit.height) === 'join') {
      const verdict = ctx.joinable(hit.key)
      if (verdict === true) {
        return { slot: current.slot, join: hit.key }
      }
      if (typeof verdict === 'string' && !ctx.reorder) {
        return { slot: current.slot, leave: true, refusal: { key: hit.key, message: verdict } }
      }
    }
    return leaveAt(hit, halves(rows, hit, y, ctx.dragged))
  }

  if (!hit) {
    return current
  }
  if (hit.kind === 'empty') {
    return ctx.reorder ? { slot: { lane: hit.lane } } : current
  }
  if (hit.kind === 'heading') {
    return ctx.reorder ? { slot: { lane: hit.lane, before: firstIn(rows, hit.lane, ctx.dragged) } } : current
  }
  const verdict = hit.kind === 'row' ? ctx.joinable(hit.key) : undefined
  if (verdict !== undefined && dropZone(y - hit.top, hit.height) === 'join') {
    if (verdict === true) {
      return { slot: current.slot, join: hit.key }
    }
    if (!ctx.reorder) {
      return { slot: current.slot, refusal: { key: hit.key, message: verdict } }
    }
  }
  return ctx.reorder ? { slot: halves(rows, hit, y, ctx.dragged) } : { slot: current.slot }
}

export function groupSlot(rows: readonly DragRow[], y: number, current: Slot, dragged: string): Slot {
  const hit = hitAt(rows, y, dragged)
  return hit ? halves(rows, hit, y, dragged) : current
}

// Puts `key` before `before` (or last) in the drawn order; keys of groups a filter hides keep their place at the end.
export function placeGroup(config: ViewConfig, drawn: readonly SessionGroup[], key: string, before: string | undefined): ViewConfig {
  const by = config.groupBy
  if (!orderedGroupBy(by)) {
    return config
  }
  const keys = drawn.filter((group) => !group.earlier).map((group) => group.key)
  if (!keys.includes(key)) {
    return config
  }
  const rest = keys.filter((k) => k !== key)
  const at = before === undefined ? -1 : rest.indexOf(before)
  const order = at < 0 ? [...rest, key] : [...rest.slice(0, at), key, ...rest.slice(at)]
  const hidden = (config.groupOrder?.[by] ?? []).filter((k) => !keys.includes(k))
  return { ...config, groupOrder: { ...config.groupOrder, [by]: [...order, ...hidden] } }
}
