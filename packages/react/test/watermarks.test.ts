import { describe, expect, it } from 'vitest'
import { Watermarks, unseenCount } from '@workerdeck/protocol'
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
    marks.mark('mac', 'a', { itemCount: 40, activity: 40, turns: 5 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 3, activity: 3, turns: 1 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 40, activity: 40, turns: 5 })
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
    const s = store({ 'mac:ancient': { itemCount: 1, activity: 1, turns: 1, seenAt: 0 } })
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
  const mark: Watermark = { itemCount: 40, activity: 40, turns: 5, seenAt: 0 }

  it('counts rows, not turns, when the gateway reports them', () => {
    expect(unseenCount(mark, { activityCount: 48, turns: 6 })).toBe(8)
  })

  it('falls back to turns for a gateway too old to report rows', () => {
    expect(unseenCount(mark, { turns: 7 })).toBe(2)
  })

  it('is zero for a session never visited', () => {
    expect(unseenCount(undefined, { activityCount: 900 })).toBe(0)
  })

  it('never goes negative when the rollup lags the mark', () => {
    expect(unseenCount(mark, { activityCount: 12 })).toBe(0)
  })

  it('prefers prose over rows: a tool-looping session badges nothing', () => {
    const read: Watermark = { itemCount: 40, activity: 40, prose: 4, turns: 5, seenAt: 0 }
    // Eight new rows, none of them anything a person is waiting to read.
    expect(unseenCount(read, { proseCount: 4, activityCount: 48, turns: 6 })).toBe(0)
    expect(unseenCount(read, { proseCount: 5, activityCount: 48, turns: 6 })).toBe(1)
  })

  it('reads a mark written before prose counting as caught up, not as a whole unread history', () => {
    // `prose` absent, `proseCount` present: the session was visited, so 40 rows of it are not news.
    expect(unseenCount(mark, { proseCount: 12, activityCount: 40 })).toBe(0)
  })

  it('badges exactly as before against a gateway too old to report prose', () => {
    expect(unseenCount(mark, { activityCount: 48, turns: 6 })).toBe(8)
  })
})

describe('Watermarks.mark, prose', () => {
  it('leaves a stored prose mark alone when the caller has nothing to say about prose', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { activity: 10, prose: 3 }, 1_000)
    // An older gateway drops out of the rollup: `prose` undefined must not read as 0.
    marks.mark('mac', 'a', { activity: 12 }, 200_000)
    expect(marks.get('mac', 'a')).toMatchObject({ activity: 12, prose: 3 })
  })

  it('moves on prose alone, so reading a paragraph clears the badge', () => {
    const marks = new Watermarks(store().seam)
    marks.mark('mac', 'a', { activity: 10, prose: 3 }, 1_000)
    expect(marks.mark('mac', 'a', { activity: 10, prose: 4 }, 1_500)).toBe(true)
  })
})
