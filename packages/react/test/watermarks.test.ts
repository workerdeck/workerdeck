import { describe, expect, it } from 'vitest'
import { Watermarks, catchUpFrom, catchUpItems, unseenCount } from '@workerdeck/protocol'
import type { Watermark, WatermarkStore } from '@workerdeck/protocol'

function store(initial: Record<string, Watermark> = {}) {
  let data = { ...initial }
  const writes: number[] = []
  return {
    seam: {
      read: () => data,
      write: (marks: Record<string, Watermark>) => {
        data = { ...marks }
        writes.push(Object.keys(marks).length)
      },
    } satisfies WatermarkStore,
    get data() {
      return data
    },
    get writes() {
      return writes.length
    },
  }
}

describe('Watermarks.mark', () => {
  it('never walks a mark backwards', () => {
    const s = store()
    const marks = new Watermarks(s.seam)
    marks.mark('mac', 'a', { itemCount: 40, conversation: 1, activity: 40 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 3, conversation: 1, activity: 3 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 40, conversation: 1, activity: 40 })
  })

  it('reports whether it moved, because nothing else will say so', () => {
    const marks = new Watermarks(store().seam)
    expect(marks.mark('mac', 'a', { activity: 10 }, 1_000)).toBe(true)
    expect(marks.mark('mac', 'a', { activity: 10 }, 1_500)).toBe(false)
    expect(marks.mark('mac', 'a', { activity: 11 }, 1_600)).toBe(true)
  })

  it('touches once a minute so "last here" stays honest', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { activity: 10 }, 1_000)
    expect(marks.mark('mac', 'a', { activity: 10 }, 1_000 + 59_000)).toBe(false)
    expect(marks.mark('mac', 'a', { activity: 10 }, 1_000 + 61_000)).toBe(true)
  })

  it('prunes marks older than 30 days on write', () => {
    const now = 100 * 24 * 60 * 60 * 1000
    const s = store({ 'mac:ancient': { itemCount: 1, activity: 1, prose: 1, seenAt: 0 } })
    const marks = new Watermarks(s.seam)
    marks.mark('mac', 'fresh', { activity: 1 }, now)
    expect(Object.keys(s.data)).toEqual(['mac:fresh'])
  })

  it('forgets a deleted session', () => {
    const s = store()
    const marks = new Watermarks(s.seam)
    marks.mark('mac', 'a', { activity: 3 }, 1_000)
    marks.forget('mac', 'a')
    expect(marks.get('mac', 'a')).toBeUndefined()
    const before = s.writes
    marks.forget('mac', 'a')
    expect(s.writes).toBe(before)
  })
})

describe('unseenCount', () => {
  const read: Watermark = { itemCount: 40, activity: 40, prose: 4, seenAt: 0 }

  it('is zero for a session never visited', () => {
    expect(unseenCount(undefined, { proseCount: 900 })).toBe(0)
  })

  it('never goes negative when the rollup lags the mark', () => {
    expect(unseenCount(read, { proseCount: 2 })).toBe(0)
  })

  it('counts prose, not rows: a tool-looping session badges nothing', () => {
    expect(unseenCount(read, { proseCount: 4 })).toBe(0)
    expect(unseenCount(read, { proseCount: 5 })).toBe(1)
  })

  it('drops a stored mark without a prose count, so its session reads as caught up', () => {
    const stored = { 'mac:a': { itemCount: 40, activity: 40, seenAt: 0 } } as unknown as Record<string, Watermark>
    const marks = new Watermarks({ read: () => stored, write: () => {} })
    expect(marks.get('mac', 'a')).toBeUndefined()
    expect(unseenCount(marks.get('mac', 'a'), { proseCount: 12 })).toBe(0)
  })
})

describe('Watermarks.mark, prose', () => {
  it('leaves a stored prose mark alone when the caller has nothing to say about prose', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { activity: 10, prose: 3 }, 1_000)
    marks.mark('mac', 'a', { activity: 12 }, 200_000)
    expect(marks.get('mac', 'a')).toMatchObject({ activity: 12, prose: 3 })
  })

  it('moves on prose alone, so reading a paragraph clears the badge', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { activity: 10, prose: 3 }, 1_000)
    expect(marks.mark('mac', 'a', { activity: 10, prose: 4 }, 1_500)).toBe(true)
  })
})

describe('Watermarks across a conversation cut', () => {
  it('badges conversation n+1 prose after a large mark in n, with the gateway counting a lifetime', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { itemCount: 200, conversation: 1, activity: 400, prose: 100 }, 1_000)
    expect(unseenCount(marks.get('mac', 'a'), { proseCount: 103 })).toBe(3)
  })

  it('takes a newer conversation item count as is, never the max with an older one', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { itemCount: 200, conversation: 1 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 5, conversation: 2 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 5, conversation: 2 })
    marks.mark('mac', 'a', { itemCount: 7, conversation: 2 }, 3_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 7, conversation: 2 })
  })

  it('lets a late mark from n move neither the item count nor the conversation of n+1', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { itemCount: 4, conversation: 2, activity: 410, prose: 102 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 200, conversation: 1, activity: 400, prose: 100 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 4, conversation: 2, activity: 410, prose: 102 })
    expect(unseenCount(marks.get('mac', 'a'), { proseCount: 105 })).toBe(3)
  })

  it('never lets a reading with no conversation raise a scoped item count', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { itemCount: 4, conversation: 2 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 90 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 4, conversation: 2 })
  })

  it('starts the recap of n+1 at the top when the mark was taken in n', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { itemCount: 200, conversation: 1 }, 1_000)
    const from = catchUpFrom(marks.get('mac', 'a'))!
    expect(from).toEqual({ itemCount: 200, since: 1_000, conversation: 1 })
    expect(catchUpItems(from, 2)).toBe(0)
    expect(catchUpItems(from, 1)).toBe(200)
    expect(catchUpItems(from, undefined)).toBe(200)
  })
})
