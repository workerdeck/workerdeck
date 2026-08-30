import type { FilePatch, PatchHunk } from '@workerdeck/protocol'
import { Row } from './row.tsx'

/**
 * A file edit, drawn the way the CLI draws it: a right-aligned line-number
 * column, a one-column `+`/`-` marker, and the line — with added and removed
 * rows carrying a full-bleed wash.
 *
 * The line numbers are the engine's own, off the wire (protocol's
 * {@link FilePatch}). Nothing here computes one: this component has never seen
 * the file, and a number it invented would be worse than no number at all —
 * it would look authoritative and send the reader to the wrong line.
 *
 * The whole row — number, marker and text — is one {@link Row}, with the number
 * and marker as its gutter. That is what keeps a wrapped line hanging under the
 * text rather than under the numbers, and it is why the gutter width is computed
 * rather than fixed: a four-digit file and a two-digit one both put their first
 * character of code on a whole column.
 */

/** Which side of the edit a body line belongs to, from its unified-diff prefix. */
type LineKind = 'context' | 'add' | 'remove'

const kindOf = (line: string): LineKind => (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context')

/**
 * The rows of one hunk, each with the line number it has *in the file*.
 *
 * Two counters, because a diff is two files interleaved: an added line has a
 * number only in the new file, a removed line only in the old one, and context
 * advances both. Showing the new number for adds and the old number for removes
 * is what makes the column mean "where do I find this line", which is the only
 * reason to print it.
 */
function hunkRows(hunk: PatchHunk): { kind: LineKind; number: number; text: string }[] {
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
 * `Edit`, where the input names the old and new text but no line numbers exist
 * because the edit has not been applied and this client has never read the file.
 *
 * `newStart: 0` is how it says so, and {@link TerminalDiff} reads that back: a
 * diff whose hunks all start at zero renders without a number column rather than
 * printing a column of zeroes or inventing an offset.
 */
export function previewPatch(input: unknown): FilePatch | undefined {
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
  // Numbers only when the engine gave any (see `previewPatch`): a column of
  // zeroes would look like line 0 of the file, which is a lie about where to
  // look — and a diff with no numbers is honest about having none.
  const numbered = patch.hunks.some((hunk) => hunk.newStart > 0)
  // Wide enough for the largest number any row will print, so the marker and the
  // code start on the same column throughout — including across a hunk boundary,
  // where the numbers jump.
  const width = numbered ? String(Math.max(...rows.flat().map((row) => row.number), 1)).length : 0
  // number + space + marker + space (or just the marker and a space)
  const columns = numbered ? width + 3 : 2

  return (
    <div className="term-diff">
      {rows.map((hunk, index) => (
        <div key={index}>
          {/* Hunks are not adjacent in the file, and a blank line would say they
              were merely a paragraph apart. The CLI's separator is the honest
              one: a row that says lines were skipped. */}
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
