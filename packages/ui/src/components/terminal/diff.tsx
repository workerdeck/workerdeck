import type { FilePatch, PatchHunk } from '@workerdeck/protocol'
import { Row } from './row.tsx'

type LineKind = 'context' | 'add' | 'remove'

function kindOf(line: string): LineKind {
  return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'
}

function hunkRows(hunk: PatchHunk): { kind: LineKind; number: number; text: string }[] {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  const rows = []
  for (const line of hunk.lines) {
    const kind = kindOf(line)
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
  const numbered = patch.hunks.some((hunk) => hunk.newStart > 0)
  const width = numbered ? String(Math.max(...rows.flat().map((row) => row.number), 1)).length : 0
  const columns = numbered ? width + 3 : 2

  return (
    <div className="term-diff">
      {rows.map((hunk, index) => (
        <div key={index}>
          {index > 0 ? <Row columns={columns} glyph={' '.repeat(width) + ' ⋮'} tone="faint" /> : null}
          {hunk.map((row, line) => (
            <Row
              key={line}
              columns={columns}
              data-diff={row.kind}
              glyph={numbered ? `${String(row.number).padStart(width)} ${MARKER[row.kind]}` : MARKER[row.kind]}
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
