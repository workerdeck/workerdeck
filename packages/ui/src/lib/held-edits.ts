import { useCallback, useEffect, useMemo, useState } from 'react'
import { sessionKey } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import type { TeamMove } from './team-drop.ts'

// What the person changed that the list has not caught up with yet; `null` is a cleared value.
export type HeldPatch = { title?: string | null; name?: string; lead?: string | null; order?: number | null }

type Field = keyof HeldPatch

// Per field, so a failed edit releases only what it wrote: `op` names the edit that last wrote the field.
export type HeldValue<V> = { value: V; until: number; op: number }

export type HeldEdit = { [F in Field]?: HeldValue<Exclude<HeldPatch[F], undefined>> }

export type HeldEdits = Readonly<Record<string, HeldEdit>>

export const HOLD_MS = 15_000

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a?.trim() || null) === (b?.trim() || null)
}

function shows(row: SessionRow, field: Field, value: unknown): boolean {
  const agent = row.info.agent
  switch (field) {
    case 'title': {
      return same(row.info.title, value as string | null)
    }
    case 'name': {
      return same(agent?.name, value as string)
    }
    case 'lead': {
      return (agent?.lead ?? null) === value
    }
    case 'order': {
      return (agent?.order ?? null) === value
    }
  }
}

function fields(edit: HeldEdit): Array<[Field, HeldValue<unknown>]> {
  return Object.entries(edit) as Array<[Field, HeldValue<unknown>]>
}

function applyEdit(row: SessionRow, edit: HeldEdit): SessionRow {
  const pending = fields(edit).filter(([field, held]) => !shows(row, field, held.value))
  if (pending.length === 0) {
    return row
  }
  const info = { ...row.info }
  const agent = info.agent && { ...info.agent }
  for (const [field, held] of pending) {
    if (field === 'title') {
      info.title = (held.value as string | null) ?? undefined
    } else if (agent && field === 'name') {
      agent.name = held.value as string
    } else if (agent && field === 'lead') {
      agent.lead = (held.value as string | null) ?? undefined
      if (held.value === null) {
        delete agent.leadGateway
        delete agent.team
      }
    } else if (agent && field === 'order') {
      agent.order = (held.value as number | null) ?? undefined
    }
  }
  if (agent) {
    info.agent = agent
  }
  return { ...row, info }
}

export function applyHeld(rows: readonly SessionRow[], held: HeldEdits): SessionRow[] {
  return rows.map((row) => {
    const edit = held[sessionKey(row)]
    return edit ? applyEdit(row, edit) : row
  })
}

function keep(held: HeldEdits, drop: (key: string, field: Field, value: HeldValue<unknown>) => boolean): HeldEdits {
  let changed = false
  const next: Record<string, HeldEdit> = {}
  for (const [key, edit] of Object.entries(held)) {
    const kept = fields(edit).filter(([field, value]) => !drop(key, field, value))
    if (kept.length !== fields(edit).length) {
      changed = true
    }
    if (kept.length > 0) {
      next[key] = Object.fromEntries(kept) as HeldEdit
    }
  }
  return changed ? next : held
}

// Drops each field the list now shows, that outlived its hold, or whose row is gone.
export function settleHeld(held: HeldEdits, rows: readonly SessionRow[], now: number): HeldEdits {
  const byKey = new Map(rows.map((row) => [sessionKey(row), row]))
  return keep(held, (key, field, value) => {
    const row = byKey.get(key)
    return !row || value.until <= now || shows(row, field, value.value)
  })
}

export function holdPatches(held: HeldEdits, patches: Array<[string, HeldPatch]>, op: number, until: number): HeldEdits {
  const next: Record<string, HeldEdit> = { ...held }
  for (const [key, patch] of patches) {
    const edit: Record<string, HeldValue<unknown>> = { ...next[key] }
    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined) {
        edit[field] = { value, until, op }
      }
    }
    next[key] = edit as HeldEdit
  }
  return next
}

export function releaseOp(held: HeldEdits, op: number): HeldEdits {
  return keep(held, (_key, _field, value) => value.op === op)
}

// Only a move the list can draw alone: every row on one gateway and one owner, so no modal can still refuse it.
export function teamMovePatches(move: TeamMove, crossOwner: boolean): Array<[string, HeldPatch]> | undefined {
  const { row, lead } = move
  const leadId = lead === null ? null : lead.info.agent?.id
  if (!row.info.agent || leadId === undefined || crossOwner || row.info.agent.leadGateway !== undefined) {
    return undefined
  }
  if ((lead && lead.hostId !== row.hostId) || move.siblings?.some((s) => s.row.hostId !== row.hostId)) {
    return undefined
  }
  const patches: Array<[string, HeldPatch]> = [
    [sessionKey(row), leadId === null ? { lead: null } : { lead: leadId, order: move.order ?? null }],
  ]
  for (const sibling of move.siblings ?? []) {
    patches.push([sessionKey(sibling.row), { order: sibling.order }])
  }
  return patches
}

let ops = 0

export function useHeldEdits(rows: readonly SessionRow[]): {
  rows: SessionRow[]
  hold: (patches: Array<[string, HeldPatch]>) => () => void
} {
  const [held, setHeld] = useState<HeldEdits>({})

  useEffect(() => {
    setHeld((current) => settleHeld(current, rows, Date.now()))
  }, [rows])

  useEffect(() => {
    const until = Math.min(...Object.values(held).flatMap((edit) => fields(edit).map(([, value]) => value.until)))
    if (!Number.isFinite(until)) {
      return
    }
    const timer = setTimeout(() => setHeld((current) => settleHeld(current, rows, Date.now())), Math.max(0, until - Date.now()))
    return () => clearTimeout(timer)
  }, [held, rows])

  const hold = useCallback((patches: Array<[string, HeldPatch]>) => {
    const op = ++ops
    setHeld((current) => holdPatches(current, patches, op, Date.now() + HOLD_MS))
    return () => setHeld((current) => releaseOp(current, op))
  }, [])

  const shown = useMemo(() => applyHeld(rows, held), [rows, held])
  return { rows: shown, hold }
}
