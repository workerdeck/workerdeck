import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import {
  buildClusters,
  railScale,
  type TerminalScrubberProps,
} from '../src/components/terminal/scrubber.tsx'

/**
 * The rail's mark model. Both bugs it has shipped were here and neither needed a
 * DOM: the streaming answer that went unmarked, and the replayed history whose
 * right lane came back empty.
 */

let seq = 0
const user = (text: string): TranscriptItem => ({ kind: 'user', id: `u${++seq}`, text })
const assistant = (text: string, parentToolUseId: string | null = null): TranscriptItem => ({
  kind: 'assistant_text',
  id: `a${++seq}`,
  text,
  streaming: false,
  parentToolUseId,
})
const turn = (isError = false): TranscriptItem => ({
  kind: 'turn_result',
  id: `r${++seq}`,
  subtype: isError ? 'error_during_execution' : 'success',
  isError,
  durationMs: 1000,
  totalCostUsd: 0.01,
})
const notice = (level: 'info' | 'error', text: string): TranscriptItem => ({
  kind: 'notice',
  id: `n${++seq}`,
  level,
  text,
})
const toolCall = (
  status: 'running' | 'settled' | 'failed',
  result?: { text: string; isError: boolean },
): TranscriptItem => ({
  kind: 'tool_call',
  id: `t${++seq}`,
  name: 'Bash',
  input: {},
  parentToolUseId: null,
  status,
  ...(result ? { result } : {}),
})

/** One row per item, 100px each — so a mark's y is its index × 10 at the scale
 * below, and two marks five items apart do not merge. */
const ROW = 100
const RAIL = 100

const props = (
  items: TranscriptItem[],
  extra: Partial<TerminalScrubberProps> = {},
): TerminalScrubberProps => ({
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
})

const kinds = (items: TranscriptItem[], extra?: Partial<TerminalScrubberProps>) =>
  buildClusters(props(items, extra), RAIL).map((c) => `${c.lane}:${c.kind}`)

describe('railScale', () => {
  it('is rail over content when the content overflows', () => {
    expect(railScale(100, 1000, 500)).toBe(0.1)
  })

  it('clamps the denominator to the viewport when everything fits', () => {
    // The bug: 90px of content in a 906px window gave a scale of ~10, so the
    // viewport band came out at 9120px inside a 906px rail — and because the
    // rail is positioned inside the scroller, that overflow became ~8000px of
    // real, empty, scrollable height under a three-row session.
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
    // A turn in flight is exactly when the rail matters most; anchoring the
    // right lane on `turn_result` left a two-minute answer unrepresented for
    // the whole two minutes.
    const items = [user('do it'), assistant('still going')]
    expect(kinds(items)).toContain('r:turn')
  })

  it('marks a replayed history that carries no turn rows at all', () => {
    // `#backfillHistory` maps only `user` and `assistant` entries, so a session
    // replayed after a gateway restart has no `turn_result` anywhere — and the
    // whole white lane used to come back empty.
    const items = [user('one'), assistant('a'), user('two'), assistant('b')]
    expect(kinds(items).filter((k) => k === 'r:turn')).toHaveLength(2)
  })

  it('anchors a turn mark on the answer, with the turn_result only decorating it', () => {
    const items = [user('do it'), assistant('the answer'), turn(true)]
    const clusters = buildClusters(props(items), RAIL)
    const right = clusters.find((c) => c.lane === 'r')!
    expect(right.kind).toBe('turnFailed') // the failure is the decoration
    expect(right.marks[0]!.mark.itemIndex).toBe(1) // …on the answer's row
    expect(right.marks[0]!.mark.turnIndex).toBe(2)
  })

  it('ignores a subagent’s answer when anchoring the turn', () => {
    const items = [user('do it'), assistant('subagent said', 'agent-1')]
    expect(kinds(items)).toEqual(['l:user'])
  })

  it('marks an error notice but not an info one', () => {
    expect(kinds([notice('error', 'boom')])).toEqual(['f:error'])
    expect(kinds([notice('info', 'fyi')])).toEqual([])
  })

  it('marks a failed tool call by either spelling', () => {
    // Both are needed: an out-of-loop execution failure sets `status` with no
    // `is_error` block to read, and an engine can flag `is_error` on a call the
    // reducer has not settled.
    expect(kinds([toolCall('failed')])).toEqual(['f:toolFailed'])
    expect(kinds([toolCall('settled', { text: 'no matches', isError: true })])).toEqual([
      'f:toolFailed',
    ])
    expect(kinds([toolCall('settled', { text: 'ok', isError: false })])).toEqual([])
    expect(kinds([toolCall('running')])).toEqual([])
  })

  it('lets a session error keep the colour when it merges with a tool failure', () => {
    // Same lane, a pixel apart: they merge, and the louder kind must win.
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
    expect(kinds([user('a')], { bookmarks: [7, -1] }).filter((k) => k.endsWith('bookmark'))).toEqual(
      [],
    )
  })

  it('marks the recap seam from its row, not from an item', () => {
    const clusters = buildClusters(
      props([user('a')], { recapRow: { rowIndex: 0, label: '3 new rows' } }),
      RAIL,
    )
    const recap = clusters.find((c) => c.marks.some((m) => m.mark.kind === 'recap'))!
    expect(recap.marks.find((m) => m.mark.kind === 'recap')!.mark.itemIndex).toBe(-1)
  })

  it('floors a mark at the hit target and never runs it past the rail', () => {
    // 400 rows at rail scale is a quarter-pixel each; every one still has to be
    // findable, and the last must not be drawn below the rail's own foot.
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
