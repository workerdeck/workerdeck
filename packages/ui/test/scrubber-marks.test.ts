import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@workerdeck/react'
import { buildMarks, clusterMarks, nearestMember } from '../src/components/agent/scrubber-marks.ts'

let seq = 0
function user(text: string): TranscriptItem {
  return { kind: 'user', id: `u${++seq}`, text }
}
function assistant(text: string, parentToolUseId: string | null = null): TranscriptItem {
  return {
    kind: 'assistant_text',
    id: `a${++seq}`,
    text,
    streaming: false,
    parentToolUseId,
  }
}
function turn(isError = false): TranscriptItem {
  return {
    kind: 'turn_result',
    id: `r${++seq}`,
    subtype: isError ? 'error_during_execution' : 'success',
    isError,
    durationMs: 1000,
    totalCostUsd: 0.01,
  }
}
function errorNotice(text: string): TranscriptItem {
  return {
    kind: 'notice',
    id: `n${++seq}`,
    level: 'error',
    text,
  }
}
function toolCall(status: 'running' | 'settled' | 'failed', parentToolUseId: string | null = null, id = `t${++seq}`): TranscriptItem {
  return {
    kind: 'tool_call',
    id,
    name: 'Bash',
    input: {},
    parentToolUseId,
    status,
  }
}

function kinds(items: TranscriptItem[]) {
  return buildMarks(items).map((m) => `${m.kind}@${m.itemIndex}`)
}

describe('buildMarks', () => {
  it('marks a prompt and its turn as one right-lane mark anchored on the answer', () => {
    const items = [user('hi'), assistant('answer'), turn()]
    expect(kinds(items)).toEqual(['user@0', 'turn@1'])
    const [, mark] = buildMarks(items)
    expect(mark!.turnIndex).toBe(2)
  })

  it('marks a live answer with no turn result yet', () => {
    expect(kinds([user('hi'), assistant('streaming…')])).toEqual(['user@0', 'turn@1'])
  })

  it('marks a replayed history that carries no turn rows at all', () => {
    expect(kinds([user('a'), assistant('one'), user('b'), assistant('two')])).toEqual(['user@0', 'turn@1', 'user@2', 'turn@3'])
  })

  it('flags a failed turn and a failed top-level call, red', () => {
    expect(kinds([user('x'), toolCall('failed'), assistant('sorry'), turn(true)])).toEqual(['user@0', 'toolFailed@1', 'turnFailed@2'])
  })

  it("marks a sub-agent dispatch in the input lane and ignores the sub-agent's own rows", () => {
    const brief: TranscriptItem = {
      kind: 'user',
      id: 'brief-1',
      text: 'the brief',
      parentToolUseId: 'task-1',
    }
    const items = [
      user('go'),
      toolCall('settled', null, 'task-1'),
      brief,
      assistant('working', 'task-1'),
      toolCall('failed', 'task-1'),
      assistant('report'),
      turn(),
    ]
    expect(kinds(items)).toEqual(['user@0', 'subagent@1', 'turn@5'])
  })

  it('inside a frame, every narration step is its own mark', () => {
    const items = [assistant('step one', 'task-1'), assistant('step two', 'task-1')]
    expect(buildMarks(items, { frameParentId: 'task-1' }).map((m) => m.kind)).toEqual(['turn', 'turn'])
  })

  it('injects bookmarks (bounds-checked) and the recap boundary', () => {
    const marks = buildMarks([user('a'), assistant('b')], {
      bookmarks: [1, 99],
      recapItemIndex: 1,
    })
    expect(marks.map((m) => `${m.kind}@${m.itemIndex}`)).toEqual(['user@0', 'turn@1', 'bookmark@1', 'recap@1'])
  })
})

describe('clusterMarks', () => {
  const RAIL = 100

  it('positions proportionally and keeps distant marks apart', () => {
    const filler = Array.from({ length: 6 }, () => toolCall('settled'))
    const items = [user('a'), assistant('b'), ...filler, user('c'), assistant('d')]
    const clusters = clusterMarks(buildMarks(items), RAIL, items.length)
    // Ten items over 100px: the prompts at items 0 and 8 sit at 0 and 80.
    expect(clusters.filter((c) => c.lane === 'l').map((c) => c.y)).toEqual([0, 80])
    expect(clusters.filter((c) => c.lane === 'r').map((c) => c.y)).toEqual([10, 90])
  })

  it('merges adjacent marks per lane, loudest colour winning', () => {
    // Three items over 100px: 33px-tall marks one item apart touch, so the answer's mark and the session error merge.
    const items = [user('a'), assistant('b'), errorNotice('boom')]
    const merged = clusterMarks(buildMarks(items), RAIL, items.length)
    const right = merged.filter((c) => c.lane === 'r')
    expect(right).toHaveLength(1)
    expect(right[0]!.kind).toBe('error')
    expect(right[0]!.marks).toHaveLength(2)
    expect(nearestMember(right[0]!, right[0]!.y + right[0]!.h)?.kind).toBe('error')
    expect(nearestMember(right[0]!, right[0]!.y)?.kind).toBe('turn')
  })

  it('keeps the same pair apart once filler spreads them', () => {
    const filler = Array.from({ length: 8 }, () => toolCall('settled'))
    const items = [user('a'), assistant('b'), ...filler, errorNotice('boom')]
    const clusters = clusterMarks(buildMarks(items), RAIL, items.length)
    expect(clusters.filter((c) => c.lane === 'r')).toHaveLength(2)
  })

  it('clamps the last mark inside the rail', () => {
    const items = [user('a'), assistant('b')]
    const clusters = clusterMarks(buildMarks(items), RAIL, items.length)
    for (const cluster of clusters) {
      expect(cluster.y + cluster.h).toBeLessThanOrEqual(RAIL)
    }
  })
})
