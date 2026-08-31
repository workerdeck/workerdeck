import type { FilePatch, PatchHunk } from '@workerdeck/protocol'

const MAX_PATCH_LINES = 400

// `@@ -oldStart,oldLines +newStart,newLines @@` — an absent count means 1 (a single-line hunk).
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const capHunks = (hunks: PatchHunk[]): { hunks: PatchHunk[]; truncated?: boolean } => {
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

const isHunk = (value: unknown): value is PatchHunk => {
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

export const filePatchFromToolResult = (result: unknown): FilePatch | undefined => {
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

export const parseUnifiedDiff = (diff: string, path?: string): FilePatch | undefined => {
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
