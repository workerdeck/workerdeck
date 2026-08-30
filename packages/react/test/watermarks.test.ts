import { describe, expect, it } from 'vitest'
import { Watermarks, unseenCount } from '@workerdeck/protocol'
import type { Watermark, WatermarkStore } from '@workerdeck/protocol'

/** An in-memory store standing in for `globalState` / `localStorage`. */
const store = (initial: Record<string, Watermark> = {}) => {
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
    // A transcript that shrank — a compaction, or a fresh attach mid-replay —
    // must not resurrect rows the user already read.
    const s = store()
    const marks = new Watermarks(s.seam)
    marks.mark('mac', 'a', { itemCount: 40, activity: 40, turns: 5 }, 1_000)
    marks.mark('mac', 'a', { itemCount: 3, activity: 3, turns: 1 }, 2_000)
    expect(marks.get('mac', 'a')).toMatchObject({ itemCount: 40, activity: 40, turns: 5 })
  })

  it('reports whether it moved, because nothing else will say so', () => {
    // Reading rows in a panel is silent: no poll, no event. A caller that
    // doesn't hear about this holds a stale unread badge indefinitely.
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
    // A forget for something absent must not write — it would churn storage on
    // every poll that sees a session already gone.
    const before = s.writes
    marks.forget('mac', 'a')
    expect(s.writes).toBe(before)
  })
})

describe('unseenCount', () => {
  const mark: Watermark = { itemCount: 40, activity: 40, turns: 5, seenAt: 0 }

  it('counts rows, not turns, when the gateway reports them', () => {
    // Five tool calls in one turn is one turn and eight rows; the badge that
    // says "1" for it is the one nobody believes.
    expect(unseenCount(mark, { activityCount: 48, turns: 6 })).toBe(8)
  })

  it('falls back to turns for a gateway too old to report rows', () => {
    expect(unseenCount(mark, { turns: 7 })).toBe(2)
  })

  it('is zero for a session never visited', () => {
    // "Never opened" is not "unread" — a badge counting every session's whole
    // history on first launch is noise on the one day it should be quiet.
    expect(unseenCount(undefined, { activityCount: 900 })).toBe(0)
  })

  it('never goes negative when the rollup lags the mark', () => {
    expect(unseenCount(mark, { activityCount: 12 })).toBe(0)
  })
})
