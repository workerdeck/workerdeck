import { describe, expect, it } from 'vitest'
import type { SessionGroup, ViewConfig } from '@workerdeck/protocol'
import { groupSlot, originSlot, placeGroup, sessionTarget, type DragRow, type SessionDragContext } from '../src/lib/row-drag.ts'

function rows(lane: string, keys: string[], from = 0, height = 40): DragRow[] {
  return keys.map((key, i) => ({ key, lane, kind: 'row', top: from + i * height, height }))
}

function card(over: Partial<SessionDragContext> = {}): SessionDragContext {
  return { dragged: 'a', origin: { lane: 'g', before: 'b' }, reorder: true, joinable: () => undefined, ...over }
}

describe('originSlot', () => {
  it('names the next row in the lane, or the end', () => {
    const list = rows('g', ['a', 'b', 'c'])
    expect(originSlot(list, 'a')).toEqual({ lane: 'g', before: 'b' })
    expect(originSlot(list, 'c')).toEqual({ lane: 'g', before: undefined })
  })
})

describe('sessionTarget for a top-level card', () => {
  const list = rows('g', ['a', 'b', 'c'])
  const start = { slot: { lane: 'g', before: 'b' } }

  it('reorders by halves of the row under the pointer', () => {
    expect(sessionTarget(list, 45, start, card()).slot).toEqual({ lane: 'g', before: 'b' })
    expect(sessionTarget(list, 75, start, card()).slot).toEqual({ lane: 'g', before: 'c' })
    expect(sessionTarget(list, 115, start, card()).slot).toEqual({ lane: 'g', before: undefined })
  })

  it('keeps the last answer over a gap, and clamps past either end', () => {
    const gapped: DragRow[] = [...rows('g', ['a', 'b']), { key: 'c', lane: 'g', kind: 'row', top: 120, height: 40 }]
    const moved = { slot: { lane: 'g', before: 'c' } }
    expect(sessionTarget(gapped, 100, moved, card())).toBe(moved)
    expect(sessionTarget(gapped, 500, moved, card()).slot).toEqual({ lane: 'g', before: undefined })
    expect(sessionTarget(rows('g', ['b', 'c'], 40), 10, moved, card()).slot).toEqual({ lane: 'g', before: 'b' })
  })

  it('joins through the middle of an agent and leaves the gap where it was', () => {
    const target = sessionTarget(list, 60, start, card({ joinable: (key) => (key === 'b' ? true : undefined) }))
    expect(target).toEqual({ slot: start.slot, join: 'b' })
    expect(sessionTarget(list, 45, start, card({ joinable: () => true })).join).toBeUndefined()
  })

  it('falls back to reordering on a refused join, and shows the refusal only where nothing reorders', () => {
    const refused = () => 'atlas leads a team; teams are one level deep'
    expect(sessionTarget(list, 55, start, card({ joinable: refused }))).toEqual({ slot: start.slot })
    expect(sessionTarget(list, 75, start, card({ joinable: refused })).slot).toEqual({ lane: 'g', before: 'c' })
    expect(sessionTarget(list, 60, start, card({ joinable: refused, reorder: false }))).toEqual({
      slot: start.slot,
      refusal: { key: 'b', message: 'atlas leads a team; teams are one level deep' },
    })
  })

  it('does not reorder without custom groups', () => {
    expect(sessionTarget(list, 75, start, card({ reorder: false }))).toEqual({ slot: start.slot })
  })

  it('lands at the top of a group through its heading, and into an empty group through its box', () => {
    const more: DragRow[] = [...list, { key: 'head:h', lane: 'h', kind: 'heading', top: 130, height: 20 }, ...rows('h', ['x'], 150)]
    expect(sessionTarget(more, 135, start, card()).slot).toEqual({ lane: 'h', before: 'x' })
    const empty: DragRow[] = [...list, { key: 'empty:e', lane: 'e', kind: 'empty', top: 130, height: 30 }]
    expect(sessionTarget(empty, 140, start, card()).slot).toEqual({ lane: 'e' })
  })
})

describe('sessionTarget for a member', () => {
  const lane = 'team:lead'
  const list: DragRow[] = [
    { key: 'lead', lane: 'g', kind: 'row', top: 0, height: 40 },
    ...rows(lane, ['m1', 'm2', 'm3'], 44),
    { key: 'other', lane: 'g', kind: 'row', top: 180, height: 40 },
    { key: 'last', lane: 'g', kind: 'row', top: 220, height: 40 },
  ]
  const origin = { lane, before: 'm3' }
  const member = (over: Partial<SessionDragContext> = {}) =>
    card({ dragged: 'm2', origin, team: { lane, lead: 'lead', leadLane: 'g', top: 0, bottom: 168 }, ...over })

  it('reorders inside its team', () => {
    expect(sessionTarget(list, 50, { slot: origin }, member()).slot).toEqual({ lane, before: 'm1' })
    expect(sessionTarget(list, 30, { slot: origin }, member()).slot).toEqual({ lane, before: 'm1' })
  })

  it('leaves above its lead or anywhere outside the team block', () => {
    expect(sessionTarget(list, 4, { slot: origin }, member())).toEqual({ slot: { lane: 'g', before: 'lead' }, leave: true })
    expect(sessionTarget(list, 175, { slot: origin }, member())).toEqual({ slot: { lane: 'g', before: 'other' }, leave: true })
    expect(sessionTarget(list, 235, { slot: origin }, member()).slot).toEqual({ lane: 'g', before: 'last' })
    expect(sessionTarget(list, 250, { slot: origin }, member({ reorder: false }))).toEqual({ slot: origin, leave: true })
  })

  it('joins another team through the middle of its lead', () => {
    const target = sessionTarget(list, 200, { slot: origin }, member({ joinable: () => true }))
    expect(target).toEqual({ slot: origin, join: 'other' })
  })
})

describe('groupSlot', () => {
  it('reorders headings by halves and never lands after a pinned one', () => {
    const list: DragRow[] = [
      ...rows('groups', ['g1', 'g2', 'g3'], 0, 20),
      { key: 'earlier', lane: 'groups', kind: 'pinned', top: 60, height: 20 },
    ]
    expect(groupSlot(list, 25, { lane: 'groups', before: 'g2' }, 'g1')).toEqual({ lane: 'groups', before: 'g2' })
    expect(groupSlot(list, 55, { lane: 'groups', before: 'g2' }, 'g1')).toEqual({ lane: 'groups', before: 'earlier' })
    expect(groupSlot(list, 75, { lane: 'groups', before: 'g2' }, 'g1')).toEqual({ lane: 'groups', before: 'earlier' })
  })
})

describe('placeGroup', () => {
  const drawn = ['a', 'b', 'c'].map((key) => ({ key, rows: [] })) as SessionGroup[]
  const config = { groupBy: 'project', groupOrder: { project: ['a', 'b', 'c', 'gone'] } } as unknown as ViewConfig

  it('puts the group before another, or last, keeping hidden keys at the end', () => {
    expect(placeGroup(config, drawn, 'c', 'a').groupOrder?.project).toEqual(['c', 'a', 'b', 'gone'])
    expect(placeGroup(config, drawn, 'a', undefined).groupOrder?.project).toEqual(['b', 'c', 'a', 'gone'])
  })
})
