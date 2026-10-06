import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import {
  backgroundableSince,
  canBackground,
  elapsedLabel,
  liveTailLines,
  runStartedAt,
  runTailLines,
} from '../src/components/terminal/live-tool.ts'
import type { ToolCallItem } from '../src/components/terminal/blocks.ts'

function call(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return { kind: 'tool_call', id: 't1', name: 'Bash', input: {}, parentToolUseId: null, status: 'running', ...overrides }
}

describe('live tool rows', () => {
  it('shows elapsed only after five seconds, without breaking the value', () => {
    expect(elapsedLabel(undefined, 10_000)).toBeUndefined()
    expect(elapsedLabel(0, 4_999)).toBeUndefined()
    expect(elapsedLabel(0, 375_400)).toBe('6m 15s')
  })

  it('tails only a running call, last lines first', () => {
    const tail = 'a\nb\nc\nd\ne\nf\ng'
    expect(liveTailLines(call({ liveTail: tail }))).toEqual(['c', 'd', 'e', 'f', 'g'])
    expect(liveTailLines(call({ liveTail: tail, status: 'settled' }))).toEqual([])
    const items = [call({ id: 'a', liveTail: 'one', ts: 50 }), call({ id: 'b', ts: 20 }), call({ id: 'c', status: 'settled', ts: 1 })]
    expect(runTailLines(items)).toEqual(['one'])
    expect(runStartedAt(items)).toBe(20)
  })

  it('offers background only on a running top-level Bash or subagent call in the current turn', () => {
    expect(canBackground(call())).toBe(true)
    expect(canBackground(call({ name: 'Task' }))).toBe(true)
    expect(canBackground(call({ name: 'Read' }))).toBe(false)
    expect(canBackground(call({ parentToolUseId: 'task-1' }))).toBe(false)
    expect(canBackground(call({ status: 'settled' }))).toBe(false)
    const prompt: TranscriptItem = { kind: 'user', id: 'u', text: 'hi' }
    expect(backgroundableSince([prompt, call({ ts: 30 }), call({ id: 'b', ts: 20 })])).toBe(20)
    expect(backgroundableSince([prompt, call({ ts: undefined })])).toBe(0)
    expect(backgroundableSince([call(), prompt])).toBeUndefined()
  })
})
