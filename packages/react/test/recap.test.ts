import { describe, expect, it } from 'vitest'
import { recapLine, summarizeSince } from '../src/recap.ts'
import type { TranscriptItem } from '../src/transcript.ts'

const user = (id: string): TranscriptItem => ({ kind: 'user', id, text: 'hi' })
const reply = (id: string): TranscriptItem => ({
  kind: 'assistant_text',
  id,
  text: 'ok',
  streaming: false,
  parentToolUseId: null,
})
const tool = (id: string, name: string, failed = false): TranscriptItem => ({
  kind: 'tool_call',
  id,
  name,
  input: {},
  parentToolUseId: null,
  status: failed ? 'failed' : 'settled',
})
const turn = (id: string, isError = false): TranscriptItem => ({
  kind: 'turn_result',
  id,
  subtype: isError ? 'error_during_execution' : 'success',
  isError,
  durationMs: 1000,
  totalCostUsd: 0.01,
})

describe('summarizeSince', () => {
  it('counts only what arrived after the boundary', () => {
    const items = [user('u1'), reply('a1'), turn('t1'), user('u2'), tool('c1', 'Read'), turn('t2')]
    const summary = summarizeSince({ items }, 3)
    expect(summary.turns).toBe(1)
    expect(summary.tools).toBe(1)
    expect(summary.replies).toBe(0)
    expect(summary.toolNames).toEqual(['Read'])
    expect(summary.any).toBe(true)
  })

  it('says nothing when nothing is new', () => {
    const items = [user('u1'), reply('a1'), turn('t1')]
    const summary = summarizeSince({ items }, items.length)
    expect(summary.any).toBe(false)
    expect(recapLine(summary)).toBeUndefined()
  })

  // A transcript can shrink — a /clear, or a re-attach after compaction. "You
  // saw 40, there are 12" means everything is new, not minus-28 of anything.
  it('clamps a boundary past the end to the whole transcript', () => {
    const items = [user('u1'), reply('a1')]
    const summary = summarizeSince({ items }, 40)
    expect(summary.any).toBe(false)
    expect(summarizeSince({ items }, -5).replies).toBe(1)
  })

  it('counts failed tools, failed turns and error notices as errors', () => {
    const items = [
      tool('c1', 'Bash', true),
      turn('t1', true),
      { kind: 'notice', id: 'n1', level: 'error', text: 'boom' } satisfies TranscriptItem,
    ]
    expect(summarizeSince({ items }, 0).errors).toBe(3)
  })

  it('ranks tool names by use and carries pending approvals', () => {
    const items = [tool('c1', 'Read'), tool('c2', 'Bash'), tool('c3', 'Read')]
    const summary = summarizeSince({ items, pendingApprovals: [{}] }, 0)
    expect(summary.toolNames).toEqual(['Read', 'Bash'])
    expect(summary.pending).toBe(1)
  })
})

describe('recapLine', () => {
  it('reads in the order a person needs it', () => {
    const items = [
      reply('a1'),
      tool('c1', 'Read'),
      tool('c2', 'Read'),
      tool('c3', 'Bash', true),
      turn('t1'),
    ]
    const line = recapLine(summarizeSince({ items, pendingApprovals: [{}] }, 0))
    expect(line).toBe('1 turn · 3 tool calls (Read, Bash) · 1 error · 1 approval waiting')
  })

  it('falls back to replies when no turn has completed yet', () => {
    expect(recapLine(summarizeSince({ items: [reply('a1'), reply('a2')] }, 0))).toBe('2 replies')
  })

  it('truncates a long tool list rather than listing everything', () => {
    const items = ['Read', 'Bash', 'Edit', 'Grep', 'Glob'].map((n, i) => tool(`c${i}`, n))
    expect(recapLine(summarizeSince({ items }, 0))).toBe('5 tool calls (Bash, Edit, Glob, +2)')
  })
})
