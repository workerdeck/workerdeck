import type { FilePatch, PatchHunk } from '@workerdeck/protocol'

const MAX_PATCH_LINES = 400

// `@@ -oldStart,oldLines +newStart,newLines @@` - an absent count means 1 (a single-line hunk).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function capHunks(hunks: PatchHunk[]): { hunks: PatchHunk[]; truncated?: boolean } {
  const kept: PatchHunk[] = []
  let lines = 0
  for (const hunk of hunks) {
    if (lines + hunk.lines.length > MAX_PATCH_LINES && kept.length > 0) {
      return { hunks: kept, truncated: true }
    }
    kept.push(hunk)
    lines += hunk.lines.length
  }
  return { hunks: kept }
}

function isHunk(value: unknown): value is PatchHunk {
  const hunk = value as Partial<PatchHunk> | null
  return (
    !!hunk &&
    typeof hunk.oldStart === 'number' &&
    typeof hunk.oldLines === 'number' &&
    typeof hunk.newStart === 'number' &&
    typeof hunk.newLines === 'number' &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === 'string')
  )
}

export function filePatchFromToolResult(result: unknown): FilePatch | undefined {
  const output = result as { filePath?: unknown; structuredPatch?: unknown; originalFile?: unknown; type?: unknown } | null | undefined
  if (!output || !Array.isArray(output.structuredPatch)) {
    return undefined
  }
  const hunks = output.structuredPatch.filter(isHunk)
  if (hunks.length === 0) {
    return undefined
  }
  const { hunks: kept, truncated } = capHunks(hunks)
  return {
    ...(typeof output.filePath === 'string' && { path: output.filePath }),
    ...(output.type === 'create' || output.originalFile === null
      ? ({ kind: 'create' } as const)
      : output.type === 'update' || typeof output.originalFile === 'string'
        ? ({ kind: 'update' } as const)
        : {}),
    hunks: kept,
    ...(truncated && { truncated }),
  }
}

export function parseUnifiedDiff(diff: string, path?: string): FilePatch | undefined {
  const hunks: PatchHunk[] = []
  let current: PatchHunk | undefined
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
      continue
    }
    if (!current) {
      continue
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      current.lines.push(line)
    } else if (line === '') {
      // A blank line is a context line whose trailing space was stripped in transit; dropping
      // it would silently shift every line number after it.
      current.lines.push(' ')
    } else {
      current = undefined
    }
  }
  if (hunks.length === 0) {
    return undefined
  }
  const { hunks: kept, truncated } = capHunks(hunks)
  return { ...(path && { path }), hunks: kept, ...(truncated && { truncated }) }
}

const PATCH_CONTEXT_LINES = 3

function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  const lines = text.split('\n')
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines
}

// One hunk around the changed span (common prefix and suffix trimmed): engines that report an edit as whole before
// and after texts give no hunks of their own.
export function filePatchFromTexts(path: string | undefined, oldText: string | null | undefined, newText: string): FilePatch | undefined {
  const before = splitLines(oldText ?? '')
  const after = splitLines(newText)
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) {
    head++
  }
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) {
    tail++
  }
  if (head === before.length && head === after.length) {
    return undefined
  }
  const start = Math.max(0, head - PATCH_CONTEXT_LINES)
  const contextAfter = Math.min(tail, PATCH_CONTEXT_LINES)
  const removed = before.slice(head, before.length - tail)
  const added = after.slice(head, after.length - tail)
  const lines = [
    ...before.slice(start, head).map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...before.slice(before.length - tail, before.length - tail + contextAfter).map((line) => ` ${line}`),
  ]
  const oldLines = head - start + removed.length + contextAfter
  const newLines = head - start + added.length + contextAfter
  const truncated = lines.length > MAX_PATCH_LINES
  const hunk = {
    oldStart: oldLines === 0 ? 0 : start + 1,
    oldLines,
    newStart: newLines === 0 ? 0 : start + 1,
    newLines,
    lines: lines.slice(0, MAX_PATCH_LINES),
  }
  return {
    ...(path !== undefined && { path }),
    kind: oldText === null || oldText === undefined ? 'create' : 'update',
    hunks: [hunk],
    ...(truncated && { truncated }),
  }
}
