import { describe, expect, it } from 'vitest'
import type { AgentRef, SessionInfo, SessionRow } from '@workerdeck/protocol'
import {
  applyHeld,
  holdPatches,
  releaseOp,
  settleHeld,
  teamMovePatches,
  type HeldEdit,
  type HeldEdits,
  type HeldPatch,
} from '../src/lib/held-edits.ts'

function row(id: string, agent?: Partial<AgentRef>, over: Partial<SessionRow> = {}, title?: string): SessionRow {
  const info = {
    id,
    title,
    status: 'idle',
    cwd: '/w',
    createdAt: 1,
    lastActivityAt: 1,
    numTurns: 0,
    pendingPermissionCount: 0,
    ...(agent ? { agent: { id: `a-${id}`, name: id, ...agent } } : {}),
  } as SessionInfo
  return { hostId: 'mac', hostName: 'Mac', local: true, adapter: 'claude', state: 'idle', unseen: 0, info, ...over }
}

function at(patch: HeldPatch, op = 1, until = 10): HeldEdit {
  return holdPatches({}, [['k', patch]], op, until)['k']!
}

describe('applyHeld', () => {
  it('draws a held rename and team place over a list that has not caught up', () => {
    const held: HeldEdits = { 'mac:s1': at({ title: 'New' }), 'mac:pip': at({ name: 'Pippa', lead: 'a-atlas', order: 2 }) }
    const [s1, pip] = applyHeld([row('s1', undefined, {}, 'Old'), row('pip', {})], held)
    expect(s1!.info.title).toBe('New')
    expect(pip!.info.agent).toMatchObject({ name: 'Pippa', lead: 'a-atlas', order: 2 })
  })

  it('clears a title, a lead and an order held as null', () => {
    const held: HeldEdits = { 'mac:s1': at({ title: null }), 'mac:pip': at({ lead: null, order: null }) }
    const [s1, pip] = applyHeld(
      [row('s1', undefined, {}, 'Old'), row('pip', { lead: 'a-atlas', leadGateway: 'g', team: 'atlas', order: 1 })],
      held,
    )
    expect(s1!.info.title).toBeUndefined()
    expect(pip!.info.agent).toEqual({ id: 'a-pip', name: 'pip' })
  })

  it('returns a row the list already agrees with untouched', () => {
    const plain = row('s1', undefined, {}, 'Same')
    expect(applyHeld([plain], { 'mac:s1': at({ title: ' Same ' }) })[0]).toBe(plain)
  })
})

describe('settleHeld', () => {
  const held: HeldEdits = { 'mac:s1': at({ title: 'New' }) }

  it('keeps an edit until the list shows it', () => {
    expect(settleHeld(held, [row('s1', undefined, {}, 'Old')], 5)).toBe(held)
    expect(settleHeld(held, [row('s1', undefined, {}, 'New')], 5)).toEqual({})
  })

  it('drops an edit past its hold or for a row that is gone', () => {
    expect(settleHeld(held, [row('s1', undefined, {}, 'Old')], 10)).toEqual({})
    expect(settleHeld(held, [], 5)).toEqual({})
  })

  it('settles field by field', () => {
    const both: HeldEdits = { 'mac:pip': at({ name: 'Pippa', order: 2 }) }
    expect(settleHeld(both, [row('pip', { name: 'Pippa' })], 5)).toEqual({ 'mac:pip': { order: { value: 2, until: 10, op: 1 } } })
  })
})

describe('releaseOp', () => {
  it('releases only the fields its own edit last wrote', () => {
    const renamed = holdPatches({}, [['mac:pip', { name: 'Pippa' }]], 1, 10)
    const moved = holdPatches(renamed, [['mac:pip', { lead: 'a-atlas', order: 0 }]], 2, 10)
    expect(releaseOp(moved, 2)).toEqual(renamed)
    expect(releaseOp(moved, 1)).toEqual({
      'mac:pip': { lead: { value: 'a-atlas', until: 10, op: 2 }, order: { value: 0, until: 10, op: 2 } },
    })
  })

  it('leaves a field a later edit rewrote', () => {
    const first = holdPatches({}, [['mac:pip', { order: 1 }]], 1, 10)
    const second = holdPatches(first, [['mac:pip', { order: 3 }]], 2, 10)
    expect(releaseOp(second, 1)).toBe(second)
  })
})

describe('teamMovePatches', () => {
  const atlas = row('atlas', { leads: true })
  const pip = row('pip', {})
  const juno = row('juno', { lead: 'a-atlas', order: 0 })

  it('places the mover and its reordered siblings', () => {
    expect(teamMovePatches({ row: pip, lead: atlas, order: 0, siblings: [{ row: juno, order: 1 }] }, false)).toEqual([
      ['mac:pip', { lead: 'a-atlas', order: 0 }],
      ['mac:juno', { order: 1 }],
    ])
  })

  it('clears only the lead on a leave, as the gateway does', () => {
    expect(teamMovePatches({ row: juno, lead: null }, false)).toEqual([['mac:juno', { lead: null }]])
  })

  it('holds nothing for a move a modal or another gateway may still refuse', () => {
    expect(teamMovePatches({ row: pip, lead: atlas }, true)).toBeUndefined()
    expect(teamMovePatches({ row: pip, lead: row('far', {}, { hostId: 'desk' }) }, false)).toBeUndefined()
    expect(
      teamMovePatches({ row: pip, lead: atlas, siblings: [{ row: row('x', {}, { hostId: 'desk' }), order: 0 }] }, false),
    ).toBeUndefined()
    expect(teamMovePatches({ row: row('plain'), lead: atlas }, false)).toBeUndefined()
  })
})
