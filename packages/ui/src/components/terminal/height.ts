import type { FilePatch, PatchHunk } from '@workerdeck/protocol'
import type { TranscriptItem } from '@workerdeck/react'
import { formatBytes, formatCost, formatDuration, toolInputPreview } from '../../lib/format.ts'
import { taskChildItems, type TerminalBlock, type ToolCallItem } from './blocks.ts'
import { IMAGE_BOX_LINES } from './image-box.ts'
import { collapsedResult } from './result-preview.ts'
import { runSummary, taskSummary } from './tool-run.ts'

export type CellMetrics = {
  width: number
  ch: number
  line: number
}

export type ComputedHeight = {
  px: number
  exact: boolean
}

export type HeightEpoch = CellMetrics & {
  cache: WeakMap<TranscriptItem, ComputedHeight>
}

export function createHeightEpoch(width: number, ch: number, line: number): HeightEpoch {
  return { width, ch, line, cache: new WeakMap() }
}

export function estimateBlockPx(block: TerminalBlock, epoch: HeightEpoch): number {
  if (!('item' in block)) {
    return blockHeight(block, epoch).px
  }
  const hit = epoch.cache.get(block.item)
  if (hit) {
    return hit.px
  }
  const computed = itemHeight(block.item, epoch)
  epoch.cache.set(block.item, computed)
  return computed.px
}

export const BRIEF_LINES = 4

export function briefPx(text: string, m: CellMetrics): number {
  const cols = Math.max(1, Math.floor(m.width / m.ch + EPS))
  return (Math.min(textLines(text, cols).lines, BRIEF_LINES) + 1) * m.line
}

// Absolutely positioned so the probe adds no layout and cannot re-trigger the ResizeObserver that called it.
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

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
]

function isWide(cp: number): boolean {
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u

function clusterCells(cluster: string): { w: number; exact: boolean } {
  if (PICTOGRAPHIC.test(cluster) || cluster.includes('‍') || cluster.includes('️')) {
    return { w: 2, exact: false }
  }
  const cp = cluster.codePointAt(0) ?? 0
  if (isWide(cp)) {
    return { w: 2, exact: false }
  }
  if (cp < 0x20) {
    return { w: 0, exact: true }
  }
  return { w: 1, exact: true }
}

type Token = { kind: 'word' | 'space'; w: number; exact: boolean }

// Must match `tab-size: 2` on the surface.
const TAB_SIZE = 2

// Break after these unless a digit follows; `?` is here because Chrome breaks long URLs after it (verified against real break rects).
const BREAK_AFTER = new Set(['-', '–', '—', '?'])

const PLAIN_ASCII = /^[\x20-\x7e]*$/

// Must stay semantically identical to `tokenize`; the height audit runs content that takes each path.
function tokenizeAscii(line: string): Token[] {
  const tokens: Token[] = []
  let wordW = 0
  const flushWord = () => {
    if (wordW > 0) {
      tokens.push({ kind: 'word', w: wordW, exact: true })
    }
    wordW = 0
  }
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code === 0x20) {
      flushWord()
      const last = tokens[tokens.length - 1]
      if (last?.kind === 'space') {
        last.w += 1
      } else {
        tokens.push({ kind: 'space', w: 1, exact: true })
      }
      continue
    }
    wordW += 1
    if (code === 0x2d || code === 0x3f) {
      const next = line.charCodeAt(i + 1)
      if (!(next >= 0x30 && next <= 0x39)) {
        flushWord()
      }
    }
  }
  flushWord()
  return tokens
}

function tokenize(line: string): Token[] {
  if (PLAIN_ASCII.test(line)) {
    return tokenizeAscii(line)
  }
  const tokens: Token[] = []
  let word = { w: 0, exact: true }
  let col = 0
  const flushWord = () => {
    if (word.w > 0) {
      tokens.push({ kind: 'word', w: word.w, exact: word.exact })
    }
    word = { w: 0, exact: true }
  }
  const segments = [...segmenter.segment(line)].map((s) => s.segment)
  for (const [index, segment] of segments.entries()) {
    if (segment === ' ') {
      flushWord()
      const last = tokens.at(-1)
      if (last?.kind === 'space') {
        last.w += 1
      } else {
        tokens.push({ kind: 'space', w: 1, exact: true })
      }
      col += 1
      continue
    }
    if (segment === '\t') {
      flushWord()
      const advance = TAB_SIZE - (col % TAB_SIZE) || TAB_SIZE
      const last = tokens.at(-1)
      if (last?.kind === 'space') {
        last.w += advance
      } else {
        tokens.push({ kind: 'space', w: advance, exact: true })
      }
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

function wrapOne(line: string, cols: number): { lines: number; exact: boolean } {
  if (cols <= 0) {
    return { lines: 1, exact: false }
  }
  const tokens = tokenize(line)
  let lines = 1
  let pos = 0
  let exact = true
  for (const token of tokens) {
    exact = exact && token.exact
    if (token.kind === 'space') {
      // Preserved spaces hang at the line end (CSS Text 3): they overflow without forcing a wrap.
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
    if (pos > 0) {
      lines += 1
    }
    const full = Math.ceil(token.w / cols)
    lines += full - 1
    pos = token.w - (full - 1) * cols
  }
  return { lines, exact }
}

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

// Layout rounds to 1/64px; the epsilon keeps a body width of exactly N × ch from flooring to N−1.
const EPS = 1e-4

type Acc = { px: number; exact: boolean }

function add(a: Acc, b: Acc): Acc {
  return { px: a.px + b.px, exact: a.exact && b.exact }
}

// `indent` resolves against the row's own `--term-cell`, so `columns={3} indent={1}` loses 3ch to the indent and 3ch to the gutter.
function rowH(text: string, m: CellMetrics, { indentCells = 0, gutterCells = 2, extraPx = 0 } = {}): Acc {
  const bodyPx = m.width - extraPx - (indentCells + gutterCells) * m.ch
  const cols = Math.floor(bodyPx / m.ch + EPS)
  const { lines, exact } = textLines(text, cols)
  return { px: lines * m.line, exact }
}

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

type MdBlock =
  | { t: 'p'; lines: string[] }
  | { t: 'h'; text: string }
  | { t: 'fence'; code: string }
  | { t: 'list'; items: { lines: string[]; gutter: number; indent: number }[] }
  | { t: 'quote'; paras: string[][] }
  | { t: 'table'; rows: number }
  | { t: 'hr' }

// CommonMark: a trailing double space or backslash is a hard break; any other newline is soft and joins with a space.
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
  if (current.length) {
    out.push(current.join(' '))
  }
  return out
}

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
      i += 1
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
          if (current.length) {
            paras.push(hardLines(current))
          }
          current = []
        } else {
          current.push(l)
        }
      }
      if (current.length) {
        paras.push(hardLines(current))
      }
      blocks.push({ t: 'quote', paras })
      continue
    }
    const listMarker = (s: string) => {
      const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(s)
      if (!m) {
        return undefined
      }
      const depth = Math.floor(m[1]!.length / 2)
      const ordered = /\d/.test(m[2]!)
      return { depth, ordered, text: m[3]! }
    }
    if (listMarker(line)) {
      const items: { lines: string[]; gutter: number; indent: number }[] = []
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
        if (m.depth === 0) {
          if (listOrdered !== undefined && m.ordered !== listOrdered) {
            break
          }
          listOrdered = m.ordered
        }
        gutters[m.depth] = m.ordered ? 3 : 2
        const indent = gutters.slice(0, m.depth).reduce((a, b) => a + (b ?? 2), 0)
        const source = [m.text]
        i += 1
        while (i < lines.length && lines[i]!.trim() !== '' && !listMarker(lines[i]!)) {
          // trimStart only: a trailing double space is the hard-break marker `hardLines` needs to see.
          source.push(lines[i]!.trimStart())
          i += 1
        }
        items.push({ lines: hardLines(source), gutter: gutters[m.depth]!, indent })
      }
      blocks.push({ t: 'list', items })
      continue
    }
    if (line.trimStart().startsWith('|')) {
      let rows = 0
      while (i < lines.length && lines[i]!.trimStart().startsWith('|')) {
        const cells = lines[i]!.trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim())
        if (!cells.every((cell) => /^:?-+:?$/.test(cell))) {
          rows += 1
        }
        i += 1
      }
      blocks.push({ t: 'table', rows: Math.max(1, rows) })
      continue
    }
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

export function markdownHeight(md: string, m: CellMetrics, extraPx = 0): Acc {
  const bodyPx = m.width - extraPx - 2 * m.ch
  const cols = Math.floor(bodyPx / m.ch + EPS)
  const blocks = parseBlocks(md)
  let acc: Acc = { px: 0, exact: true }
  for (const [index, block] of blocks.entries()) {
    if (index > 0) {
      acc = add(acc, { px: m.line, exact: true })
    }
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
          if (pi > 0) {
            px += m.line
          }
          for (const line of para) {
            const r = textLines(line, cols - 2)
            px += r.lines * m.line
            exact = exact && r.exact
          }
        }
        acc = add(acc, { px, exact })
        break
      }
      case 'table': {
        acc = add(acc, { px: block.rows * m.line, exact: true })
        break
      }
      case 'hr': {
        acc = add(acc, { px: m.line, exact: true })
        break
      }
    }
  }
  return { px: Math.max(acc.px, m.line), exact: acc.exact }
}

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
  const width = numbered ? String(Math.max(...hunks.flat().map((row) => row.number), 1)).length : 0
  const columns = numbered ? width + 3 : 2
  let acc: Acc = { px: 0, exact: true }
  for (const [index, hunk] of hunks.entries()) {
    if (index > 0) {
      acc = add(acc, { px: m.line, exact: true })
    } // the ⋮ separator row
    for (const row of hunk) {
      acc = add(acc, rowH(row.text || ' ', m, { indentCells: 2, gutterCells: columns, extraPx }))
    }
  }
  if (patch.truncated) {
    acc = add(acc, { px: m.line, exact: true })
  }
  return acc
}

function toolRowHeight(item: ToolCallItem, m: CellMetrics, extraPx: number): Acc {
  const preview = toolInputPreview(item.input)
  const backend = item.backend && item.backend !== 'server' ? ` · ${item.backend}` : ''
  let acc = rowH(`${item.name}(${preview})${backend}`, m, { gutterCells: 2, extraPx })

  const images = item.result?.images
  if (images?.length) {
    acc = add(acc, { px: images.length * IMAGE_BOX_LINES * m.line, exact: true })
  }

  if (item.patch) {
    return add(acc, diffHeight(item.patch, m, extraPx))
  }
  const text = item.result?.text ?? ''
  if (!text) {
    return acc
  }
  const { shown, more } = collapsedResult(text.trimEnd().split('\n'), item.result?.totalChars)
  for (const line of shown) {
    acc = add(acc, rowH(line || ' ', m, { indentCells: 3, gutterCells: 3, extraPx }))
  }
  if (more) {
    acc = add(acc, rowH(more, m, { indentCells: 3, gutterCells: 3, extraPx }))
  }
  return acc
}

// Nested rows are stepped in behind a rule: `border-l-2` (2px) + `pl-3` (12px) on the wrapper in `agent/Transcript.tsx`.
function nestedExtraPx(item: TranscriptItem): number {
  return 'parentToolUseId' in item && item.parentToolUseId != null ? 14 : 0
}

export function itemHeight(item: TranscriptItem, m: CellMetrics): ComputedHeight {
  const extraPx = nestedExtraPx(item)
  switch (item.kind) {
    case 'user': {
      let acc: Acc = { px: 0, exact: true }
      if (item.attachments?.length) {
        acc = add(acc, rowH(item.attachments.map((a) => a.name).join(', '), m, { extraPx }))
      }
      if (item.text) {
        for (const line of item.text.split('\n')) {
          acc = add(acc, rowH(line || ' ', m, { extraPx }))
        }
      }
      return acc
    }
    case 'assistant_text': {
      return markdownHeight(item.text, m, extraPx)
    }
    case 'thinking': {
      return rowH(item.text, m, { extraPx })
    }
    case 'tool_call': {
      return toolRowHeight(item, m, extraPx)
    }
    case 'turn_result': {
      let acc = rowH(`${item.isError ? item.subtype : 'done'} · ${formatDuration(item.durationMs)} · ${formatCost(item.totalCostUsd)}`, m, {
        extraPx,
      })
      for (const message of item.errors ?? []) {
        acc = add(acc, rowH(message, m, { extraPx }))
      }
      return acc
    }
    case 'notice': {
      return rowH(item.text, m, { extraPx })
    }
    case 'file_delivered': {
      const text = `${item.path} · ${formatBytes(item.bytes)}` + (item.description ? ` · ${item.description}` : '')
      return rowH(text, m, { extraPx })
    }
    default: {
      return { px: 0, exact: false }
    }
  }
}

export function blockHeight(block: TerminalBlock, m: CellMetrics): ComputedHeight {
  if ('task' in block) {
    return rowH(taskSummary(block.task, taskChildItems(block)), m)
  }
  if ('run' in block) {
    const busy = block.run.some((item) => item.status === 'running' || item.status === 'pending')
    return rowH(runSummary(block.run, busy), m)
  }
  return itemHeight(block.item, m)
}
