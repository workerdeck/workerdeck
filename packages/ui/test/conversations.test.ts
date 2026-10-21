import { describe, expect, it } from 'vitest'
import { archivedBannerText, conversationRowText, conversationSpan } from '../src/lib/conversations.ts'

const at = Date.UTC(2026, 9, 18, 12, 0)

describe('conversation rows', () => {
  it('spans minutes, hours and days', () => {
    expect(conversationSpan(20_000)).toBe('under a minute')
    expect(conversationSpan(35 * 60_000)).toBe('35m')
    expect(conversationSpan(120 * 60_000)).toBe('2h')
    expect(conversationSpan(134 * 60_000)).toBe('2h 14m')
    expect(conversationSpan(72 * 3_600_000)).toBe('3d')
  })

  it('runs the current conversation to now and leaves an unknown span out', () => {
    const current = conversationRowText({ n: 3, startedAt: at, current: true }, at + 10 * 60_000, 'en-US')
    expect(current).toMatchObject({ title: 'Untitled conversation', duration: '10m', current: true })
    expect(current.date).toContain('Oct 18, 2026')
    const legacy = conversationRowText({ n: 1, current: false })
    expect(legacy).toEqual({ date: 'Date unknown', title: 'Untitled conversation', current: false })
    expect(conversationRowText({ n: 2, transcript: 'unavailable', current: false }).title).toBe('Transcript unavailable')
  })
})

describe('archived banner', () => {
  it('names a past conversation and says when its agent or transcript is gone', () => {
    expect(archivedBannerText({ kind: 'past', at, current: 3, unavailable: false }, 'en-US').headline).toMatch(
      /^Past conversation · Oct 18, 2026/,
    )
    expect(archivedBannerText({ kind: 'past', at, unavailable: false }).note).toBeUndefined()
    expect(archivedBannerText({ kind: 'deleted', at, unavailable: false }).note).toBe('Agent deleted')
    expect(archivedBannerText({ kind: 'deleted', at, unavailable: true }).note).toBe('Agent deleted · Transcript unavailable')
  })
})
