import type { FilePatch, PatchHunk } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import {
  formatBytes,
  formatCost,
  formatDuration,
  toolInputPreview,
} from '../../lib/format.ts'
import type { TerminalBlock, ToolCallItem } from './items.tsx'

/**
 * The terminal theme's row-height calculator.
 *
 * Computes, from a {@link TranscriptItem} and the cell metrics alone — no DOM —
 * the pixel height the terminal renderer will draw it at. This exists because
 * the theme makes it possible: one line height, one cell, monospace, ligatures
 * off. It is a *terminal* capability, deliberately homed here rather than in a
 * generic location — the cards variant has padding scales, borders and a
 * proportional face, and nothing in this file transfers to it.
 *
 * The consumer is the virtualizer's `estimateSize` (see `agent/Transcript.tsx`):
 * a computed height governs a row only until the row mounts and is measured, so
 * the contract is "almost always exact, and honest when it cannot be". Honesty
 * is the `exact` flag on {@link ComputedHeight}: `false` marks content whose
 * advance this model cannot know — emoji and CJK render from fallback faces
 * whose advances are not whole cells.
 * Measured against the real renderer in the dev playground
 * (`dev/height-audit.ts`): every unflagged row was pixel-exact across fixtures,
 * widths and cell sizes — the audit is this file's regression gate, and
 * `_docs/references/scrubber/height-calculator-spike.md` is the paper trail.
 *
 * Two invariants keep the model small, and both are load-bearing:
 *
 * - **Only the default state is ever computed.** A tool row's expansion is
 *   component-local state that resets when the row unmounts, so an off-screen
 *   row is always collapsed — and an expanded row is by definition mounted,
 *   which means the virtualizer has its real measurement. There is no
 *   open/expanded branch here on purpose.
 * - **Mutation is object replacement.** The transcript reducer never mutates an
 *   item in place — streaming text, a result arriving, a patch attaching each
 *   produce a new object — which is what lets {@link HeightEpoch}'s cache key on
 *   identity and never go stale.
 *
 * The wrap model mirrors `.term-body` (`white-space: pre-wrap` +
 * `overflow-wrap: break-word` in a `minmax(0,1fr)` grid column): greedy fill,
 * breaks at preserved spaces (which hang at the line end rather than wrapping),
 * after hyphens/dashes/`?` not followed by a digit (verified against Chrome's
 * actual break points in long URLs), and between CJK characters; a token wider
 * than the whole column moves to its own line first and then breaks per cell —
 * which is exactly where `break-word` differs from `anywhere`.
 */

/** The cell everything is measured in. `ch` is the advance of `0` in px —
 * *measured* off the live surface via {@link measureCh}, never derived from the
 * font size (7.83px at 13px JetBrains Mono, not 13 × 0.6). */
export type CellMetrics = {
  /** Content-box width of the virtual row wrapper, px. */
  width: number
  /** Advance of `0`, px. */
  ch: number
  /** `--term-line`, px. */
  line: number
}

export type ComputedHeight = {
  px: number
  /** False when the content contains glyphs or structures whose rendered size
   * this model cannot know — treat the row as an estimate, corrected the
   * moment it mounts and measures. */
  exact: boolean
}

/* ── The epoch ─────────────────────────────────────────────────────────────
 *
 * One cache generation. **Owned by the transcript shell** (`TranscriptRows` in
 * `agent/Transcript.tsx` holds exactly one, in React state): it is created from
 * the first real measurement of the mounted surface and *replaced wholesale*
 * whenever width, `ch` or line change — a computed height is only meaningful
 * against the metrics it was computed for, so partial invalidation is a bug
 * factory and a new WeakMap is free. Within an epoch the cache keys on item
 * object identity, which the reducer's replace-on-mutation discipline turns
 * into automatic invalidation: a streamed delta is a new object and simply
 * misses. Shell-run blocks are not cached — the folded array is rebuilt every
 * render, so its identity is worthless as a key, and a collapsed run is one
 * `wrapOne` over a short string (~2µs).
 */
export type HeightEpoch = CellMetrics & {
  cache: WeakMap<TranscriptItem, ComputedHeight>
}

export function createHeightEpoch(width: number, ch: number, line: number): HeightEpoch {
  return { width, ch, line, cache: new WeakMap() }
}

/** A virtual row's computed height under `epoch` — the `estimateSize` feed.
 * The inter-row gap is the *pair's* business (`gapBefore`), not the row's, so
 * it is added by the caller. */
export function estimateBlockPx(block: TerminalBlock, epoch: HeightEpoch): number {
  if ('shell' in block) return blockHeight(block, epoch).px
  const hit = epoch.cache.get(block.item)
  if (hit) return hit.px
  const computed = itemHeight(block.item, epoch)
  epoch.cache.set(block.item, computed)
  return computed.px
}

/** Measure the advance of `0` on the live surface. A DOM read — call it from
 * the epoch's measurement pass (an effect / ResizeObserver callback), never
 * from render. The probe is absolutely positioned, so it contributes no layout
 * and cannot re-trigger the observer that called it. */
export function measureCh(surface: HTMLElement): number {
  const probe = document.createElement('span')
  probe.textContent = '0'.repeat(200)
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  probe.style.whiteSpace = 'pre'
  surface.appendChild(probe)
  const width = probe.getBoundingClientRect().width / 200
  probe.remove()
  return width
}

/* ── Cell counting ─────────────────────────────────────────────────────────── */

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols/punctuation
  [0x3041, 0x33ff], // Hiragana … CJK compatibility
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]

const isWide = (cp: number): boolean => WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

/** One grapheme cluster's advance, in cells. Wide and pictographic clusters are
 * counted as 2 but flagged: they render from a fallback face whose advance is
 * not a whole number of cells, and the flag is what keeps the model honest. */
function clusterCells(cluster: string): { w: number; exact: boolean } {
  if (PICTOGRAPHIC.test(cluster) || cluster.includes('‍') || cluster.includes('️'))
    return { w: 2, exact: false }
  const cp = cluster.codePointAt(0) ?? 0
  if (isWide(cp)) return { w: 2, exact: false }
  if (cp < 0x20) return { w: 0, exact: true }
  return { w: 1, exact: true }
}

/* ── The wrap model ────────────────────────────────────────────────────────── */

type Token = { kind: 'word' | 'space'; w: number; exact: boolean }

/** `tab-size: 2` on the surface. */
const TAB_SIZE = 2

/** Break *after* these when the next character is not a digit. The digit guard
 * keeps `protocol-0.16.0` together; `?` is in the set because Chrome breaks
 * long URLs after it (verified against real break rects). */
const BREAK_AFTER = new Set(['-', '–', '—', '?'])

/** Printable ASCII, tab excluded: every character is one cell and one grapheme,
 * so the segmenter has nothing to tell us. This is nearly every line a
 * transcript holds, and the segmenter was the calculator's whole CPU bill —
 * ~1s of a 30s scroll sweep on the 4k-item perf fixture, all of it spent
 * segmenting text that `charCodeAt` classifies for free. */
const PLAIN_ASCII = /^[\x20-\x7e]*$/

/** The ASCII half of {@link tokenize}: same tokens, same break rules ('-' and
 * '?' break unless a digit follows; '–'/'—' are not ASCII), no segmenter and
 * no per-grapheme allocation. Must stay semantically identical to the general
 * path — the height audit runs both, via content that takes each. */
function tokenizeAscii(line: string): Token[] {
  const tokens: Token[] = []
  let wordW = 0
  const flushWord = () => {
    if (wordW > 0) tokens.push({ kind: 'word', w: wordW, exact: true })
    wordW = 0
  }
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code === 0x20) {
      flushWord()
      const last = tokens[tokens.length - 1]
      if (last?.kind === 'space') last.w += 1
      else tokens.push({ kind: 'space', w: 1, exact: true })
      continue
    }
    wordW += 1
    if (code === 0x2d /* - */ || code === 0x3f /* ? */) {
      const next = line.charCodeAt(i + 1)
      if (!(next >= 0x30 && next <= 0x39)) flushWord()
    }
  }
  flushWord()
  return tokens
}

/**
 * Tokenize one hard line into wrap units. Tabs advance to the next 2-cell stop
 * measured from the hard line's start — position-dependent after a soft wrap in
 * principle, but content with tabs beyond the first wrap point is vanishingly
 * rare and the error is bounded by one tab stop.
 */
function tokenize(line: string): Token[] {
  if (PLAIN_ASCII.test(line)) return tokenizeAscii(line)
  const tokens: Token[] = []
  let word = { w: 0, exact: true }
  let col = 0
  const flushWord = () => {
    if (word.w > 0) tokens.push({ kind: 'word', w: word.w, exact: word.exact })
    word = { w: 0, exact: true }
  }
  const segments = [...segmenter.segment(line)].map((s) => s.segment)
  for (const [index, segment] of segments.entries()) {
    if (segment === ' ') {
      flushWord()
      const last = tokens.at(-1)
      if (last?.kind === 'space') last.w += 1
      else tokens.push({ kind: 'space', w: 1, exact: true })
      col += 1
      continue
    }
    if (segment === '\t') {
      flushWord()
      const advance = TAB_SIZE - (col % TAB_SIZE) || TAB_SIZE
      const last = tokens.at(-1)
      if (last?.kind === 'space') last.w += advance
      else tokens.push({ kind: 'space', w: advance, exact: true })
      col += advance
      continue
    }
    const { w, exact } = clusterCells(segment)
    const cp = segment.codePointAt(0) ?? 0
    if (isWide(cp) || PICTOGRAPHIC.test(segment)) {
      // Each wide cluster is its own token — a break may fall between any two.
      flushWord()
      tokens.push({ kind: 'word', w, exact })
      col += w
      continue
    }
    word.w += w
    word.exact = word.exact && exact
    col += w
    if (BREAK_AFTER.has(segment) && !/^\d/.test(segments[index + 1] ?? '')) {
      flushWord()
    }
  }
  flushWord()
  return tokens
}

/** Visual lines one hard line occupies at `cols` columns. */
function wrapOne(line: string, cols: number): { lines: number; exact: boolean } {
  if (cols <= 0) return { lines: 1, exact: false }
  const tokens = tokenize(line)
  let lines = 1
  let pos = 0
  let exact = true
  for (const token of tokens) {
    exact = exact && token.exact
    if (token.kind === 'space') {
      // Preserved spaces hang at the line end (CSS Text 3): they may overflow
      // without forcing a wrap, and the next word starts the next line.
      pos += token.w
      continue
    }
    if (pos + token.w <= cols) {
      pos += token.w
      continue
    }
    if (token.w <= cols) {
      lines += 1
      pos = token.w
      continue
    }
    // break-word: the token first moves to its own line, then fills whole lines.
    if (pos > 0) lines += 1
    const full = Math.ceil(token.w / cols)
    lines += full - 1
    pos = token.w - (full - 1) * cols
  }
  return { lines, exact }
}

/** Visual lines of a (possibly multi-hard-line) text at `cols` columns.
 * Exported for the dev audit; also the one genuinely pure piece a unit test
 * could pin, should `ui` ever grow a runner. */
export function textLines(text: string, cols: number): { lines: number; exact: boolean } {
  let lines = 0
  let exact = true
  for (const hard of text.split('\n')) {
    const r = wrapOne(hard, cols)
    lines += Math.max(1, r.lines)
    exact = exact && r.exact
  }
  return { lines: Math.max(1, lines), exact }
}

/* ── Rows ──────────────────────────────────────────────────────────────────── */

/** Layout rounds to 1/64px; the epsilon keeps a body width that is exactly
 * N × ch from flooring to N−1. */
const EPS = 1e-4

type Acc = { px: number; exact: boolean }

const add = (a: Acc, b: Acc): Acc => ({ px: a.px + b.px, exact: a.exact && b.exact })

/**
 * One `Row`: `indentCells` of padding (already resolved against the row's own
 * `--term-cell` — a `columns={3} indent={1}` row loses 3ch to the indent *and*
 * 3ch to the gutter, because the indent padding reads the same variable the
 * override sets), `gutterCells` of gutter, the body wrapping in what is left.
 * `extraPx` is non-cell chrome around the row (the nested-run border+padding).
 */
function rowH(
  text: string,
  m: CellMetrics,
  { indentCells = 0, gutterCells = 2, extraPx = 0 } = {},
): Acc {
  const bodyPx = m.width - extraPx - (indentCells + gutterCells) * m.ch
  const cols = Math.floor(bodyPx / m.ch + EPS)
  const { lines, exact } = textLines(text, cols)
  return { px: lines * m.line, exact }
}

/* ── Markdown ──────────────────────────────────────────────────────────────── */

/** Rendered text of an inline run — markers stripped the way the component map
 * renders them (`**bold**` is 4 chars narrower on screen than in source).
 * Approximate: reference links, raw HTML and nested emphasis edge cases are
 * not modelled. */
function stripInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/``([^`]+)``/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\s][^*]*)\*/g, '$1')
    .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+.!-])/g, '$1')
}

/**
 * Text blocks carry **rendered lines**, resolved by CommonMark's own break
 * rule: a source line ending in two spaces (or a backslash) is a hard break
 * and renders as `<br>`; any other newline is soft and collapses to a space
 * under `white-space: normal`. Both halves are load-bearing and each was the
 * whole model once. Join-always missed the hard breaks — models write poems
 * with trailing double-spaces, and a 350-line one estimated ~115 lines short
 * (a phantom scrollbar tail, scrubber marks resizing as rows mounted).
 * Break-always missed the soft ones and overestimated the same stanza written
 * without them by four lines. The `markdown` fixture carries one poem of each
 * as the audit's guard.
 */
type MdBlock =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; text: string }
  | { t: 'fence'; code: string }
  | { t: 'list'; items: { lines: string[]; gutter: number; indent: number }[] }
  | { t: 'quote'; paras: string[][] }
  /** One line per row, unconditionally — see the `table` case in
   * {@link markdownHeight}. */
  | { t: 'table'; rows: number }
  | { t: 'hr' }

/** Source lines of one paragraph-ish run → the lines the renderer draws: hard
 * breaks (trailing double space or backslash) split, soft newlines join with a
 * space. The break marker itself never renders and is stripped. */
function hardLines(source: string[]): string[] {
  const out: string[] = []
  let current: string[] = []
  for (const raw of source) {
    const hard = /(?:\s{2}|\\)$/.test(raw)
    current.push(stripInline(raw.replace(/(?:\s+|\\)$/, '')))
    if (hard) {
      out.push(current.join(' '))
      current = []
    }
  }
  if (current.length) out.push(current.join(' '))
  return out
}

/** A line-based CommonMark-ish block parser — just enough structure to mirror
 * what Streamdown + the terminal component map emit for transcript content. */
function parseBlocks(md: string): MdBlock[] {
  const lines = md.split('\n')
  const blocks: MdBlock[] = []
  let i = 0
  const isBlank = (s: string | undefined) => s !== undefined && s.trim() === ''
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') {
      i += 1
      continue
    }
    if (line.startsWith('```')) {
      const code: string[] = []
      i += 1
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        code.push(lines[i]!)
        i += 1
      }
      i += 1 // closing fence (or EOF, mid-stream)
      blocks.push({ t: 'fence', code: code.join('\n') })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      blocks.push({ t: 'h', text: stripInline(h[2]!) })
      i += 1
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i += 1
      continue
    }
    if (/^>\s?/.test(line)) {
      const raw: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        raw.push(lines[i]!.replace(/^>\s?/, ''))
        i += 1
      }
      const paras: string[][] = []
      let current: string[] = []
      for (const l of raw) {
        if (l.trim() === '') {
          if (current.length) paras.push(hardLines(current))
          current = []
        } else current.push(l)
      }
      if (current.length) paras.push(hardLines(current))
      blocks.push({ t: 'quote', paras })
      continue
    }
    const listMarker = (s: string) => {
      const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(s)
      if (!m) return undefined
      const depth = Math.floor(m[1]!.length / 2)
      const ordered = /\d/.test(m[2]!)
      return { depth, ordered, text: m[3]! }
    }
    if (listMarker(line)) {
      const items: { lines: string[]; gutter: number; indent: number }[] = []
      // Marker cells per level, outermost first — a nested item's indent is the
      // sum of its ancestors' gutters (each nested list sits in its parent li's
      // body column).
      const gutters: number[] = []
      let listOrdered: boolean | undefined
      while (i < lines.length) {
        const m = listMarker(lines[i]!)
        if (!m) {
          if (isBlank(lines[i]) && listMarker(lines[i + 1] ?? '')) {
            i += 1
            continue
          }
          break
        }
        // A different marker type at the top level starts a *new* list — one
        // more block, one more inter-block margin.
        if (m.depth === 0) {
          if (listOrdered !== undefined && m.ordered !== listOrdered) break
          listOrdered = m.ordered
        }
        gutters[m.depth] = m.ordered ? 3 : 2
        const indent = gutters.slice(0, m.depth).reduce((a, b) => a + (b ?? 2), 0)
        const source = [m.text]
        i += 1
        // Lazy continuation lines belong to the item; whether each newline
        // renders is `hardLines`' call, same as a paragraph's.
        while (i < lines.length && lines[i]!.trim() !== '' && !listMarker(lines[i]!)) {
          // trimStart only: a trailing double space is the hard-break marker,
          // and `hardLines` needs to see it.
          source.push(lines[i]!.trimStart())
          i += 1
        }
        items.push({ lines: hardLines(source), gutter: gutters[m.depth]!, indent })
      }
      blocks.push({ t: 'list', items })
      continue
    }
    if (line.trimStart().startsWith('|')) {
      // Only the row count. A table lays out at `max-content` and scrolls rather
      // than compressing, so a row is a line whatever the cells hold — the
      // per-column width measuring this used to do fed a wrap model that no
      // longer exists, and it was real work on every table.
      let rows = 0
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) {
        const cells = lines[i]!
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
        // The `|---|:--:|` delimiter row is structure, not a rendered line.
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) rows += 1
        i += 1
      }
      blocks.push({ t: 'table', rows: Math.max(1, rows) })
      continue
    }
    // Paragraph: gather until a blank line or another block opener.
    const para: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !lines[i]!.startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^>\s?/.test(lines[i]!) &&
      !listMarker(lines[i]!) &&
      !lines[i]!.trimStart().startsWith('|') &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)
    ) {
      para.push(lines[i]!)
      i += 1
    }
    blocks.push({ t: 'p', lines: hardLines(para) })
  }
  return blocks
}

/** The markdown body's height: blocks, one line between consecutive ones
 * (`.term-md .term-block + .term-block`). Exported for the dev audit only. */
export function markdownHeight(md: string, m: CellMetrics, extraPx = 0): Acc {
  const bodyPx = m.width - extraPx - 2 * m.ch // the outer Row's gutter
  const cols = Math.floor(bodyPx / m.ch + EPS)
  const blocks = parseBlocks(md)
  let acc: Acc = { px: 0, exact: true }
  for (const [index, block] of blocks.entries()) {
    if (index > 0) acc = add(acc, { px: m.line, exact: true })
    switch (block.t) {
      case 'p': {
        for (const line of block.lines) {
          const r = textLines(line, cols)
          acc = add(acc, { px: r.lines * m.line, exact: r.exact })
        }
        break
      }
      case 'h': {
        const r = textLines(block.text, cols)
        acc = add(acc, { px: r.lines * m.line, exact: r.exact })
        break
      }
      case 'fence': {
        let px = 0
        let exact = true
        for (const codeLine of block.code.split('\n')) {
          const r = wrapOne(codeLine, cols)
          px += Math.max(1, r.lines) * m.line
          exact = exact && r.exact
        }
        acc = add(acc, { px: Math.max(px, m.line), exact })
        break
      }
      case 'list': {
        let px = 0
        let exact = true
        for (const item of block.items) {
          for (const line of item.lines) {
            const r = textLines(line, cols - item.indent - item.gutter)
            px += r.lines * m.line
            exact = exact && r.exact
          }
        }
        acc = add(acc, { px, exact })
        break
      }
      case 'quote': {
        let px = 0
        let exact = true
        for (const [pi, para] of block.paras.entries()) {
          if (pi > 0) px += m.line
          for (const line of para) {
            const r = textLines(line, cols - 2)
            px += r.lines * m.line
            exact = exact && r.exact
          }
        }
        acc = add(acc, { px, exact })
        break
      }
      case 'table':
        // One line per row, always. A table is laid out at `max-content` and
        // carries no `max-width`, so a wide one scrolls inside
        // `.term-table-wrap` rather than compressing — which means the auto
        // table layout never wraps a cell and there is nothing here to model.
        // This used to branch on whether the table fit, and flag the wide case:
        // that branch was the theme's own `max-width: 100%` leaking into the
        // calculator, and both went at once. See `terminal.css` §Markdown.
        acc = add(acc, { px: block.rows * m.line, exact: true })
        break
      case 'hr':
        acc = add(acc, { px: m.line, exact: true })
        break
    }
  }
  return { px: Math.max(acc.px, m.line), exact: acc.exact }
}

/* ── Items ─────────────────────────────────────────────────────────────────── */

function diffHeight(patch: FilePatch, m: CellMetrics, extraPx = 0): Acc {
  const walk = (hunk: PatchHunk) => {
    let newLine = hunk.newStart
    let oldLine = hunk.oldStart
    return hunk.lines.map((line) => {
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'
      const text = line.slice(1)
      const number = kind === 'add' ? newLine++ : kind === 'remove' ? oldLine++ : newLine
      if (kind === 'context') {
        oldLine++
        newLine++
      }
      return { number, text }
    })
  }
  const hunks = patch.hunks.map(walk)
  const numbered = patch.hunks.some((hunk) => hunk.newStart > 0)
  const width = numbered
    ? String(Math.max(...hunks.flat().map((row) => row.number), 1)).length
    : 0
  const columns = numbered ? width + 3 : 2
  let acc: Acc = { px: 0, exact: true }
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) acc = add(acc, { px: m.line, exact: true }) // the ⋮ separator row
    for (const row of hunk) {
      acc = add(acc, rowH(row.text || ' ', m, { indentCells: 2, gutterCells: columns, extraPx }))
    }
  }
  if (patch.truncated) acc = add(acc, { px: m.line, exact: true })
  return acc
}

/** How much of a tool result the collapsed row shows — `items.tsx`'s
 * `RESULT_PREVIEW_LINES`, restated because that module keeps it private. The
 * dev audit is what keeps the two from drifting. */
const RESULT_PREVIEW_LINES = 4

/** A collapsed tool row: the header, then the diff (when the call carries a
 * patch) or up to four result lines plus the `… +N lines` row. No expanded
 * branch — see the module comment's first invariant. */
function toolRowHeight(item: ToolCallItem, m: CellMetrics, extraPx: number): Acc {
  const preview = toolInputPreview(item.input)
  const backend = item.backend && item.backend !== 'server' ? ` · ${item.backend}` : ''
  let acc = rowH(`${item.name}(${preview})${backend}`, m, { gutterCells: 2, extraPx })

  if (item.patch) return add(acc, diffHeight(item.patch, m, extraPx))
  const text = item.result?.text ?? ''
  if (!text) return acc
  const lines = text.trimEnd().split('\n')
  const shown = lines.slice(0, RESULT_PREVIEW_LINES)
  for (const line of shown) {
    // indent=1 with columns=3 resolves the indent against the row's own
    // --term-cell: 3ch of padding + 3ch of gutter.
    acc = add(acc, rowH(line || ' ', m, { indentCells: 3, gutterCells: 3, extraPx }))
  }
  const hidden = lines.length - shown.length
  if (hidden > 0)
    acc = add(
      acc,
      rowH(`… +${hidden} line${hidden === 1 ? '' : 's'}`, m, {
        indentCells: 3,
        gutterCells: 3,
        extraPx,
      }),
    )
  return acc
}

/** Rows produced inside a subagent are stepped in behind a rule —
 * `border-l-2` (2px) + `pl-3` (12px) on the wrapper in `agent/Transcript.tsx`. */
const nestedExtraPx = (item: TranscriptItem): number =>
  'parentToolUseId' in item && item.parentToolUseId != null ? 14 : 0

/** One transcript item's height, in its default (collapsed, settled-or-not)
 * presentation. */
export function itemHeight(item: TranscriptItem, m: CellMetrics): ComputedHeight {
  const extraPx = nestedExtraPx(item)
  switch (item.kind) {
    case 'user': {
      let acc: Acc = { px: 0, exact: true }
      if (item.attachments?.length)
        acc = add(acc, rowH(item.attachments.map((a) => a.name).join(', '), m, { extraPx }))
      if (item.text)
        for (const line of item.text.split('\n')) acc = add(acc, rowH(line || ' ', m, { extraPx }))
      return acc
    }
    case 'assistant_text':
      return markdownHeight(item.text, m, extraPx)
    case 'thinking':
      return rowH(item.text, m, { extraPx })
    case 'tool_call':
      return toolRowHeight(item, m, extraPx)
    case 'turn_result': {
      let acc = rowH(
        `${item.isError ? item.subtype : 'done'} · ${formatDuration(item.durationMs)} · ${formatCost(item.totalCostUsd)}`,
        m,
        { extraPx },
      )
      for (const message of item.errors ?? []) acc = add(acc, rowH(message, m, { extraPx }))
      return acc
    }
    case 'notice':
      return rowH(item.text, m, { extraPx })
    case 'file_delivered': {
      const text =
        `${item.path} · ${formatBytes(item.bytes)}` +
        (item.description ? ` · ${item.description}` : '')
      return rowH(text, m, { extraPx })
    }
    default:
      return { px: 0, exact: false }
  }
}

/** A virtual row's height: an item, or a folded shell run (collapsed = its one
 * summary line). */
export function blockHeight(block: TerminalBlock, m: CellMetrics): ComputedHeight {
  if ('shell' in block) {
    const n = block.shell.length
    const busy = block.shell.some(
      (item) => item.status === 'running' || item.status === 'pending',
    )
    return rowH(
      `${busy ? 'Running ' : 'Ran '}${n} shell command${n === 1 ? '' : 's'}${busy ? '…' : ''}`,
      m,
    )
  }
  return itemHeight(block.item, m)
}
