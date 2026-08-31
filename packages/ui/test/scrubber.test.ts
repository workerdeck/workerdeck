import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { buildClusters, railScale, type TerminalScrubberProps } from '../src/components/terminal/scrubber.tsx'

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
function notice(level: 'info' | 'error', text: string): TranscriptItem {
  return {
    kind: 'notice',
    id: `n${++seq}`,
    level,
    text,
  }
}
function toolCall(status: 'running' | 'settled' | 'failed', result?: { text: string; isError: boolean }): TranscriptItem {
  return {
    kind: 'tool_call',
    id: `t${++seq}`,
    name: 'Bash',
    input: {},
    parentToolUseId: null,
    status,
    ...(result ? { result } : {}),
  }
}

// One row per item, 100px each — so a mark's y is its index × 10 at this scale, and two marks five items apart do not merge.
const ROW = 100
const RAIL = 100

function props(items: TranscriptItem[], extra: Partial<TerminalScrubberProps> = {}): TerminalScrubberProps {
  return {
    items,
    pendingApprovals: [],
    bookmarks: [],
    rowIndexFor: (i) => i,
    offsetOfRow: (row) => row * ROW,
    sizeOfRow: () => ROW,
    totalSize: Math.max(items.length, 1) * ROW,
    scrollOffset: 0,
    viewportH: 200,
    onJumpToRow: () => {},
    interactive: true,
    ...extra,
  }
}

// Every mark with the lane its cluster drew it in — clusters merge, so a cluster-level filter silently loses the quieter member.
function members(clusters: ReturnType<typeof buildClusters>) {
  return clusters.flatMap((c) => c.marks.map((m) => ({ lane: c.lane, ...m.mark })))
}

function kinds(items: TranscriptItem[], extra?: Partial<TerminalScrubberProps>) {
  return buildClusters(props(items, extra), RAIL).map((c) => `${c.lane}:${c.kind}`)
}

describe('inside a sub-agent frame', () => {
  const framed = (text: string) => assistant(text, 'task-1')
  const failedChild = (): TranscriptItem => ({
    kind: 'tool_call',
    id: `t${++seq}`,
    name: 'Bash',
    input: {},
    parentToolUseId: 'task-1',
    status: 'failed',
  })

  it('marks every narration step, where the conversation marks one per segment', () => {
    const items = [framed('looking'), framed('found it'), framed('done')]
    // Counted as members, not clusters: three marks this close merge into one cluster on a 100px rail.
    const marks = members(buildClusters(props(items, { frameParentId: 'task-1' }), RAIL))
    expect(marks.map((m) => m.kind)).toEqual(['turn', 'turn', 'turn'])
    expect(marks.map((m) => m.itemIndex)).toEqual([0, 1, 2])
  })

  it('marks a failure the frame’s own renderer reddens', () => {
    const items = [framed('trying'), failedChild()]
    expect(members(buildClusters(props(items, { frameParentId: 'task-1' }), RAIL)).map((m) => m.kind)).toContain('toolFailed')
  })

  it('still marks nothing of a sub-agent’s in the conversation itself', () => {
    expect(kinds([user('go'), framed('looking'), assistant('done'), turn()])).toEqual(['l:user', 'r:turn'])
  })
})

describe('railScale', () => {
  it('is rail over content when the content overflows', () => {
    expect(railScale(100, 1000, 500)).toBe(0.1)
  })

  it('clamps the denominator to the viewport when everything fits', () => {
    const scale = railScale(906, 90, 906)
    expect(scale).toBe(1)
    expect(906 * scale).toBeLessThanOrEqual(906) // the band can never exceed the rail
  })

  it('is zero for an empty transcript rather than dividing by nothing', () => {
    expect(railScale(100, 0, 500)).toBe(0)
  })
})

describe('buildClusters', () => {
  it('marks a prompt on the left and its answer on the right', () => {
    const items = [user('do it'), assistant('...'), assistant('done'), turn()]
    expect(kinds(items).sort()).toEqual(['l:user', 'r:turn'])
  })

  it('marks a live answer that has no turn_result yet', () => {
    const items = [user('do it'), assistant('still going')]
    expect(kinds(items)).toContain('r:turn')
  })

  it('marks a replayed history that carries no turn rows at all', () => {
    const items = [user('one'), assistant('a'), user('two'), assistant('b')]
    expect(kinds(items).filter((k) => k === 'r:turn')).toHaveLength(2)
  })

  it('anchors a turn mark on the answer, with the turn_result only decorating it', () => {
    const items = [user('do it'), assistant('the answer'), turn(true)]
    const clusters = buildClusters(props(items), RAIL)
    const right = clusters.find((c) => c.lane === 'r')!
    expect(right.kind).toBe('turnFailed')
    expect(right.marks[0]!.mark.itemIndex).toBe(1)
    expect(right.marks[0]!.mark.turnIndex).toBe(2)
  })

  it('ignores a subagent’s answer when anchoring the turn', () => {
    const items = [user('do it'), assistant('subagent said', 'agent-1')]
    expect(kinds(items)).toEqual(['l:user'])
  })

  it('paints no prompt mark for a subagent’s brief', () => {
    const brief: TranscriptItem = {
      kind: 'user',
      id: `u${++seq}`,
      text: 'go find it',
      parentToolUseId: 'task-1',
    }
    const items = [user('do it'), assistant('working on it'), brief, assistant('the answer')]
    const clusters = buildClusters(props(items), RAIL)
    expect(clusters.filter((c) => c.kind === 'user')).toHaveLength(1)
    const turns = clusters.filter((c) => c.kind === 'turn')
    expect(turns).toHaveLength(1)
    expect(turns[0]!.marks[0]!.mark.itemIndex).toBe(3)
  })

  it('bands a sub-agent in the input lane, by membership and not by name', () => {
    const spawn: TranscriptItem = {
      kind: 'tool_call',
      id: 'agent-1',
      name: 'Agent',
      input: {},
      parentToolUseId: null,
      status: 'settled',
    }
    const child: TranscriptItem = {
      kind: 'tool_call',
      id: 'c1',
      name: 'Grep',
      input: {},
      parentToolUseId: 'agent-1',
      status: 'settled',
    }
    const clusters = buildClusters(props([user('go'), spawn, child, assistant('done')]), RAIL)
    // Marks, not clusters: a dispatch a row below the prompt merges with it in the shared input lane and would vanish from a cluster-level filter.
    const band = members(clusters).filter((m) => m.kind === 'subagent')
    expect(band).toHaveLength(1)
    expect(band[0]!.lane).toBe('l')
    expect(band[0]!.itemIndex).toBe(1)
    // A childless tool call is not a sub-agent.
    expect(members(buildClusters(props([user('go'), toolCall('settled')]), RAIL)).map((m) => `${m.lane}:${m.kind}`)).not.toContain(
      'l:subagent',
    )
  })

  it('gives a failed sub-agent a band AND a failure mark, one per channel', () => {
    const spawn: TranscriptItem = {
      kind: 'tool_call',
      id: 'task-1',
      name: 'Task',
      input: {},
      parentToolUseId: null,
      status: 'failed',
    }
    const child: TranscriptItem = {
      kind: 'tool_call',
      id: 'c1',
      name: 'Read',
      input: {},
      parentToolUseId: 'task-1',
      status: 'settled',
    }
    const marks = members(buildClusters(props([user('go'), spawn, child]), RAIL))
    expect(marks.filter((m) => m.kind === 'subagent').map((m) => m.lane)).toEqual(['l'])
    expect(marks.filter((m) => m.kind === 'toolFailed').map((m) => m.lane)).toEqual(['r'])
  })

  it('lets a prompt keep the input lane when a dispatch merges with it', () => {
    const spawn: TranscriptItem = {
      kind: 'tool_call',
      id: 'task-1',
      name: 'Task',
      input: {},
      parentToolUseId: null,
      status: 'settled',
    }
    const child: TranscriptItem = {
      kind: 'tool_call',
      id: 'c1',
      name: 'Read',
      input: {},
      parentToolUseId: 'task-1',
      status: 'settled',
    }
    const clusters = buildClusters(props([user('go'), spawn, child], { rowIndexFor: () => 0, offsetOfRow: () => 0 }), RAIL)
    const left = clusters.filter((c) => c.lane === 'l')
    expect(left).toHaveLength(1)
    expect(left[0]!.kind).toBe('user')
    expect(left[0]!.marks.map((m) => m.mark.kind)).toContain('subagent')
  })

  it('does NOT mark a failed tool call inside a subagent', () => {
    const failed: TranscriptItem = {
      kind: 'tool_call',
      id: `t${++seq}`,
      name: 'Bash',
      input: {},
      parentToolUseId: 'task-1',
      status: 'failed',
    }
    expect(kinds([failed])).toEqual([])
  })

  it('does NOT mark a failure the model recovered from inside its run', () => {
    // `kinds` maps one row per item by default, so a run has to be spelled by pinning them to a shared row — which is what folding does.
    const a = toolCall('settled', { text: 'no such file', isError: true })
    const b = toolCall('settled', { text: 'ok', isError: false })
    expect(kinds([a, b], { rowIndexFor: () => 0 })).toEqual([])
  })

  it('marks the run outcome when it is the failure', () => {
    const a = toolCall('settled', { text: 'ok', isError: false })
    const b = toolCall('settled', { text: 'no matches', isError: true })
    expect(kinds([a, b], { rowIndexFor: () => 0 })).toEqual(['r:toolFailed'])
  })

  it('marks an error notice but not an info one', () => {
    expect(kinds([notice('error', 'boom')])).toEqual(['r:error'])
    expect(kinds([notice('info', 'fyi')])).toEqual([])
  })

  it('marks a failed tool call by either spelling', () => {
    expect(kinds([toolCall('failed')])).toEqual(['r:toolFailed'])
    expect(kinds([toolCall('settled', { text: 'no matches', isError: true })])).toEqual(['r:toolFailed'])
    expect(kinds([toolCall('settled', { text: 'ok', isError: false })])).toEqual([])
    expect(kinds([toolCall('running')])).toEqual([])
  })

  it('lets a session error keep the colour when it merges with a tool failure', () => {
    const items = [toolCall('failed'), notice('error', 'boom')]
    const clusters = buildClusters(props(items), RAIL)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.kind).toBe('error')
    expect(clusters[0]!.marks).toHaveLength(2)
  })

  it('keeps every merged member, so the pointer can resolve to the nearest', () => {
    const items = [user('a'), user('b'), user('c')]
    const clusters = buildClusters(props(items), RAIL)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.marks.map((m) => m.mark.itemIndex)).toEqual([0, 1, 2])
  })

  it('pins a waiting approval at the rail’s foot, full width', () => {
    const request = { id: 'p1', toolName: 'Bash', input: {} } as PermissionRequest
    const clusters = buildClusters(props([user('a')], { pendingApprovals: [request] }), RAIL)
    const approval = clusters.find((c) => c.kind === 'approval')!
    expect(approval.lane).toBe('f')
    expect(approval.y).toBe(RAIL - 2)
  })

  it('drops a bookmark pointing outside the transcript', () => {
    expect(kinds([user('a')], { bookmarks: [0] })).toContain('f:bookmark')
    expect(kinds([user('a')], { bookmarks: [7, -1] }).filter((k) => k.endsWith('bookmark'))).toEqual([])
  })

  it('marks the recap seam from its row, not from an item', () => {
    const clusters = buildClusters(props([user('a')], { recapRow: { rowIndex: 0, label: '3 new rows' } }), RAIL)
    const recap = clusters.find((c) => c.marks.some((m) => m.mark.kind === 'recap'))!
    expect(recap.marks.find((m) => m.mark.kind === 'recap')!.mark.itemIndex).toBe(-1)
  })

  it('floors a mark at the hit target and never runs it past the rail', () => {
    const items = Array.from({ length: 400 }, (_, i) => user(`p${i}`))
    for (const cluster of buildClusters(props(items), RAIL)) {
      expect(cluster.h).toBeGreaterThanOrEqual(2)
      expect(cluster.y).toBeGreaterThanOrEqual(0)
      expect(cluster.y).toBeLessThanOrEqual(RAIL - 2)
    }
  })

  it('paints nothing for an empty transcript', () => {
    expect(buildClusters(props([]), RAIL)).toEqual([])
  })
})

describe('marks inside a shared row', () => {
  const failedChild = () => [user('go'), toolCall('failed')]

  it('anchors a shared-row mark fractionally, at the hit-target height', () => {
    // rowH 400, viewportH 200, RAIL 100 → scale 0.25; ordinal 2 of 4 is halfway down a row whose top is 0 → y = round(200 × 0.25) = 50.
    const clusters = buildClusters(
      props(failedChild(), {
        rowIndexFor: () => 0,
        offsetOfRow: () => 0,
        sizeOfRow: () => 400,
        totalSize: 400,
        positionInRow: (i) => (i === 1 ? { ordinal: 2, count: 4 } : undefined),
      }),
      RAIL,
    )
    const failed = clusters.find((c) => c.kind === 'toolFailed')!
    expect(failed.h).toBe(2)
    expect(failed.y).toBe(50)
  })

  it('reproduces today’s full-extent band when the prop is absent', () => {
    const clusters = buildClusters(
      props(failedChild(), {
        rowIndexFor: () => 0,
        offsetOfRow: () => 0,
        sizeOfRow: () => 400,
        totalSize: 400,
      }),
      RAIL,
    )
    expect(clusters.find((c) => c.kind === 'toolFailed')!.h).toBe(100)
  })

  it('merges siblings when the row is collapsed to one line', () => {
    // Collapsed, the shared row is one 20px line in a long transcript: every fraction rounds into the same rail pixel, so two failures read as one mark.
    const items = [user('go'), toolCall('failed'), toolCall('failed')]
    const collapsed = {
      rowIndexFor: () => 0,
      offsetOfRow: () => 0,
      sizeOfRow: () => 20,
      totalSize: 20_000,
    }
    const withFraction = buildClusters(props(items, { ...collapsed, positionInRow: (i) => ({ ordinal: i - 1, count: 2 }) }), RAIL).filter(
      (c) => c.kind === 'toolFailed',
    )
    expect(withFraction).toHaveLength(1)
    const before = buildClusters(props(items, collapsed), RAIL).filter((c) => c.kind === 'toolFailed')
    expect(withFraction.map((c) => [c.y, c.h])).toEqual(before.map((c) => [c.y, c.h]))
  })

  it('clamps the last sibling of a tall row inside the rail', () => {
    const clusters = buildClusters(
      props(failedChild(), {
        rowIndexFor: () => 0,
        offsetOfRow: () => 0,
        sizeOfRow: () => 10_000,
        totalSize: 10_000,
        positionInRow: () => ({ ordinal: 99, count: 100 }),
      }),
      RAIL,
    )
    expect(clusters.find((c) => c.kind === 'toolFailed')!.y).toBe(RAIL - 2)
  })

  it('applies to a bookmark on an absorbed child too — the same bug', () => {
    const items = [user('go'), toolCall('settled')]
    const clusters = buildClusters(
      props(items, {
        bookmarks: [1],
        rowIndexFor: () => 0,
        offsetOfRow: () => 0,
        sizeOfRow: () => 400,
        totalSize: 400,
        positionInRow: (i) => (i === 1 ? { ordinal: 1, count: 4 } : undefined),
      }),
      RAIL,
    )
    const bookmark = clusters.find((c) => c.kind === 'bookmark')!
    expect(bookmark.h).toBe(2)
    expect(bookmark.y).toBe(25)
  })
})
