import { describe, expect, it } from 'vitest'
import { PULSE_FRAMES, PULSE_MS, PULSE_REST, pulseFrameAt } from '../src/components/agent/pulse.tsx'

describe('pulseFrameAt', () => {
  it('derives the frame from the wall clock', () => {
    expect(pulseFrameAt(0)).toBe(PULSE_FRAMES[0])
    expect(pulseFrameAt(PULSE_MS)).toBe(PULSE_FRAMES[1])
    expect(pulseFrameAt(PULSE_MS * 3 + PULSE_MS - 1)).toBe(PULSE_FRAMES[3])
  })

  it('wraps over the frame count', () => {
    expect(pulseFrameAt(PULSE_MS * PULSE_FRAMES.length)).toBe(PULSE_FRAMES[0])
    expect(pulseFrameAt(1_756_000_000_000)).toBe(pulseFrameAt(1_756_000_000_000 + PULSE_MS * PULSE_FRAMES.length))
  })

  it('agrees for every caller reading the same instant', () => {
    const now = Date.now()
    expect(new Set([pulseFrameAt(now), pulseFrameAt(now), pulseFrameAt(now)]).size).toBe(1)
  })

  it('rests on a glyph that is not a frame', () => {
    expect(PULSE_FRAMES).not.toContain(PULSE_REST)
  })
})
