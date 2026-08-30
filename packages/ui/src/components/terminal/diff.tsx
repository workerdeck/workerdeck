/**
 * A file edit, drawn the way the CLI draws it: right-aligned line numbers, a
 * `+`/`-` marker, the line, full-bleed wash on adds/removes.
 *
 * Line numbers are the engine's own, off the wire ({@link FilePatch}) — this
 * component has never seen the file, and an invented number would look
 * authoritative while sending the reader to the wrong line. Number + marker
 * form the {@link Row} gutter, so a wrapped line hangs under the text, not the
 * numbers.
 */

import type { FilePatch, PatchHunk } from '@workerdeck/protocol'
import { Row } from './row.tsx'

/** Which side of the edit a body line belongs to, from its unified-diff prefix. */
type LineKind = 'context' | 'add' | 'remove'

const kindOf = (line: string): LineKind => (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context')

/**
 * The rows of one hunk, each with its line number *in the file*: the new
 * number for adds, the old for removes, context advancing both — so the
 * column means "where do I find this line".
 */
const hunkRows = (hunk: PatchHunk): { kind: LineKind; number: number; text: string }[] => {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const rows = []
  for (const line of hunk.lines) {
    const kind = kindOf(line)
    // The prefix is diff syntax, not content — the marker column says it now.
    const text = line.slice(1)
    if (kind === 'add') {
      rows.push({ kind, number: newLine++, text })
    } else if (kind === 'remove') {
      rows.push({ kind, number: oldLine++, text })
    } else {
      rows.push({ kind, number: newLine, text })
      oldLine++
      newLine++
    }
  }
  return rows
}

const MARKER = { context: ' ', add: '+', remove: '-' } as const

/**
 * A patch for a change that has **not happened yet** — an approval prompt's
 * `Edit`, where no line numbers exist. `newStart: 0` is how it says so, and
 * {@link TerminalDiff} reads that back: all-zero hunks render without a number
 * column.
 */
export const previewPatch = (input: unknown): FilePatch | undefined => {
  const edit = input as { file_path?: unknown; old_string?: unknown; new_string?: unknown } | null
  const before = typeof edit?.old_string === 'string' ? edit.old_string : undefined
  const after = typeof edit?.new_string === 'string' ? edit.new_string : undefined
  if (before === undefined && after === undefined) {
    return undefined
  }
  const lines = [
    ...(before ? before.split('\n').map((line) => `-${line}`) : []),
    ...(after ? after.split('\n').map((line) => `+${line}`) : []),
  ]
  if (lines.length === 0) {
    return undefined
  }
  return {
    ...(typeof edit?.file_path === 'string' && { path: edit.file_path }),
    hunks: [{ oldStart: 0, oldLines: 0, newStart: 0, newLines: 0, lines }],
  }
}

export function TerminalDiff({ patch }: { patch: FilePatch }) {
  const rows = patch.hunks.map(hunkRows)
  // Numbers only when the engine gave any (see `previewPatch`).
  const numbered = patch.hunks.some((hunk) => hunk.newStart > 0)
  // Wide enough for the largest number any row prints, so the marker and code
  // stay on one column across hunk boundaries.
  const width = numbered ? String(Math.max(...rows.flat().map((row) => row.number), 1)).length : 0
  // number + space + marker + space (or just the marker and a space)
  const columns = numbered ? width + 3 : 2

  return (
    <div className="term-diff">
      {rows.map((hunk, index) => (
        <div key={index}>
          {/* The CLI's skipped-lines separator; a blank line would read as a paragraph break. */}
          {index > 0 ? <Row columns={columns} glyph={' '.repeat(width) + ' ⋮'} tone="faint" /> : null}
          {hunk.map((row, line) => (
            <Row
              key={line}
              columns={columns}
              data-diff={row.kind}
              glyph={numbered ? `${String(row.number).padStart(width)} ${MARKER[row.kind]}` : MARKER[row.kind]}
              // `pre-wrap` on the body already keeps the code's own indentation;
              // an empty line still has to occupy its row, hence the space.
            >
              {row.text || ' '}
            </Row>
          ))}
        </div>
      ))}
      {patch.truncated ? (
        <Row columns={columns} tone="faint">
          … diff truncated
        </Row>
      ) : null}
    </div>
  )
}
