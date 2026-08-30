/**
 * The height calculator's regression gate — compares the shipped calculator
 * (`src/components/terminal/height.ts`, the `estimateSize` feed) against the real DOM,
 * which no jsdom test can do: the property under test is agreement with a browser's
 * text layout. For every *mounted* virtual row it buckets the error as exact (<0.6px),
 * off by one line, or worse. The virtualizer mounts only viewport plus overscan, so
 * callers audit at several scroll positions and merge (`window.__wdAudit` in App.tsx).
 */

import type { TranscriptState } from '@workerdeck/react'
import { blockHeight, measureCh, type CellMetrics } from '../src/components/terminal/height.ts'
import { terminalBlocks, type TerminalBlock } from '../src/components/terminal/items.tsx'

const round = (n: number): number => Math.round(n * 100) / 100

export type HeightAuditRow = {
  index: number
  kind: string
  measured: number
  computed: number
  /** measured − computed, px. */
  delta: number
  /** False when the calculator flagged the content as unknowable (emoji/CJK). */
  exact: boolean
  text: string
}

export type HeightAuditReport = {
  line: number
  ch: number
  width: number
  rows: HeightAuditRow[]
  summary: {
    total: number
    exactRows: number
    oneLine: number
    worse: number
    flagged: number
  }
  byKind: Record<string, { total: number; exact: number; maxDelta: number }>
}

/**
 * Which virtual-row slot the recap boundary occupies, or `Infinity` when there is
 * none. Mirrors the splice in `Transcript`: the recap goes in front of the *block*
 * carrying its item, so a folded shell run before the boundary moves it up.
 */
const recapRowIndex = (blocks: TerminalBlock[], from: number | undefined): number => {
  if (from === undefined) {
    return Infinity
  }
  const at = blocks.findIndex((block) => block.index >= from)
  return at < 0 ? Infinity : at
}

export function auditHeights(
  state: TranscriptState,
  root: HTMLElement,
  /** `catchUp.from`, when the transcript was given one — see {@link recapRowIndex}. */
  catchUpFrom?: number,
): HeightAuditReport {
  const surface = root.querySelector<HTMLElement>('[data-terminal]')
  if (!surface) {
    throw new Error('no [data-terminal] surface mounted')
  }
  const style = getComputedStyle(surface)
  const line = Number.parseFloat(style.getPropertyValue('--term-line'))
  const ch = measureCh(surface)
  const blocks = terminalBlocks(state.items, 0, true)
  const wrappers = surface.querySelectorAll<HTMLElement>(
    // Descendant, not child: a prompt row under `stickyPrompt` sits inside its
    // sticky lane, one level down.
    '[data-slot="transcript-rows"] [data-index]',
  )
  // The transcript splices a recap row into the virtual list, so a wrapper's
  // `data-index` is a *row* index while blocks are indexed by *block*; past the splice
  // the two differ by one and every row would be audited against its neighbour. The
  // boundary must be *told*, not found: the recap row is unmounted precisely when you
  // are reading far enough away for the offset to matter.
  const recapIndex = recapRowIndex(blocks, catchUpFrom)

  const rows: HeightAuditRow[] = []
  let width = 0
  for (const el of wrappers) {
    const index = Number(el.dataset.index)
    if (index === recapIndex) {
      continue
    } // a boundary, not a transcript block
    const block = blocks[index > recapIndex ? index - 1 : index]
    if (!block) {
      continue
    }
    width = el.clientWidth
    const gap = el.classList.contains('term-row-gap') ? line : 0
    const metrics: CellMetrics = { width, ch, line }
    const { px, exact } = blockHeight(block, metrics)
    const measured = el.getBoundingClientRect().height
    const computed = px + gap
    const kind = 'run' in block ? 'shell_run' : 'task' in block ? 'task' : block.item.kind
    const text = (
      'run' in block ? `${block.run.length} cmds` : 'task' in block ? `task ${block.childIndices.length} children` : previewOf(block.item)
    ).slice(0, 40)
    rows.push({
      index,
      kind,
      measured: round(measured),
      computed: round(computed),
      delta: round(measured - computed),
      exact,
      text,
    })
  }
  rows.sort((a, b) => a.index - b.index)
  const summary = { total: rows.length, exactRows: 0, oneLine: 0, worse: 0, flagged: 0 }
  const byKind: HeightAuditReport['byKind'] = {}
  for (const row of rows) {
    const abs = Math.abs(row.delta)
    if (abs < 0.6) {
      summary.exactRows += 1
    } else if (Math.abs(abs - line) < 0.6) {
      summary.oneLine += 1
    } else {
      summary.worse += 1
    }
    if (!row.exact) {
      summary.flagged += 1
    }
    const bucket = (byKind[row.kind] ??= { total: 0, exact: 0, maxDelta: 0 })
    bucket.total += 1
    if (abs < 0.6) {
      bucket.exact += 1
    }
    bucket.maxDelta = Math.max(bucket.maxDelta, abs)
  }
  return { line, ch: round(ch), width, rows, summary, byKind }
}

const previewOf = (item: { kind: string } & Record<string, unknown>): string => {
  const text = item.text ?? item.name ?? item.path ?? item.subtype ?? ''
  return typeof text === 'string' ? text.replace(/\s+/g, ' ') : String(text)
}
