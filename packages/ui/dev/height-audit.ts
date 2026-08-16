/**
 * The height calculator's regression gate — compares the *shipped* calculator
 * (`src/components/terminal/height.ts`, the `estimateSize` feed) against the
 * real DOM, which no jsdom test can do: the property under test is agreement
 * with a browser's text layout. Kept beside `grid-audit.ts` for the same
 * reason that one exists — "looks right" is not a property you can hold by eye.
 *
 * For every *mounted* virtual row it computes the expected height from the
 * transcript item alone and compares it with `getBoundingClientRect().height`,
 * bucketing the error: exact (<0.6px), off by one line, worse. The virtualizer
 * mounts only the viewport plus overscan, so callers audit at several scroll
 * positions and merge (`window.__wdAudit` in App.tsx is the harness).
 */

import type { TranscriptState } from '@workerdeck/react'
import {
  blockHeight,
  measureCh,
  type CellMetrics,
} from '../src/components/terminal/height.ts'
import { terminalBlocks, type TerminalBlock } from '../src/components/terminal/items.tsx'

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
 * Which virtual-row slot the recap boundary occupies, given the item index it
 * is spliced at — or `Infinity` when there is no boundary. Mirrors the splice
 * in `Transcript`: the recap goes in front of the *block* that carries its
 * item, so a folded shell run before the boundary moves it up by the calls it
 * swallowed.
 */
function recapRowIndex(blocks: TerminalBlock[], from: number | undefined): number {
  if (from === undefined) return Infinity
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
  if (!surface) throw new Error('no [data-terminal] surface mounted')
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
  // `data-index` is a *row* index while the blocks are indexed by *block*.
  // After the splice the two differ by one, and comparing across that offset
  // audits every row against its neighbour — which reads as a broken calculator
  // rather than a broken instrument. It reported 16 unflagged misses on the only
  // fixture carrying a splice and none anywhere else, which is the signature.
  //
  // The boundary has to be *told*, not found: the recap row is unmounted
  // whenever you are reading far from it, and that is exactly when the rows
  // being audited are the ones the offset applies to. Locating it in the DOM
  // works only while it happens to be on screen — which is to say, it does not
  // work.
  const recapIndex = recapRowIndex(blocks, catchUpFrom)

  const rows: HeightAuditRow[] = []
  let width = 0
  for (const el of wrappers) {
    const index = Number(el.dataset.index)
    if (index === recapIndex) continue // a boundary, not a transcript block
    const block = blocks[index > recapIndex ? index - 1 : index]
    if (!block) continue
    width = el.clientWidth
    const gap = el.classList.contains('term-row-gap') ? line : 0
    const metrics: CellMetrics = { width, ch, line }
    const { px, exact } = blockHeight(block, metrics)
    const measured = el.getBoundingClientRect().height
    const computed = px + gap
    const kind = 'run' in block ? 'shell_run' : block.item.kind
    const text = ('run' in block ? `${block.run.length} cmds` : previewOf(block.item)).slice(
      0,
      40,
    )
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
    if (abs < 0.6) summary.exactRows += 1
    else if (Math.abs(abs - line) < 0.6) summary.oneLine += 1
    else summary.worse += 1
    if (!row.exact) summary.flagged += 1
    const bucket = (byKind[row.kind] ??= { total: 0, exact: 0, maxDelta: 0 })
    bucket.total += 1
    if (abs < 0.6) bucket.exact += 1
    bucket.maxDelta = Math.max(bucket.maxDelta, abs)
  }
  return { line, ch: round(ch), width, rows, summary, byKind }
}

const round = (n: number): number => Math.round(n * 100) / 100

function previewOf(item: { kind: string } & Record<string, unknown>): string {
  const text = item.text ?? item.name ?? item.path ?? item.subtype ?? ''
  return typeof text === 'string' ? text.replace(/\s+/g, ' ') : String(text)
}
