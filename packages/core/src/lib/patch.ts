import type { FilePatch, PatchHunk } from '@workerdeck/protocol'

/**
 * Turning an engine's edit output into the wire's {@link FilePatch}.
 *
 * Both engines know exactly which lines of which file changed, and both say so
 * in their own vocabulary: the Claude SDK hands over a `structuredPatch` array
 * on `SDKUserMessage.tool_use_result`, codex puts a unified diff string on each
 * `fileChange` item. A client can reconstruct neither — it has never seen the
 * file — so anything not normalized here is a diff that renders without line
 * numbers.
 *
 * Normalizing in the runner rather than in each client is the point: one shape
 * reaches the wire, and the dashboard, the extension and the phone all render
 * from it without a per-engine branch or a diff parser of their own.
 */

/**
 * The most lines a patch may put on the wire.
 *
 * A patch is replayed on every attach and captured into parking snapshots, so
 * "the diff is big" must not become "this session is expensive to open forever".
 * Whole hunks are kept or dropped — half a hunk has misleading line numbers —
 * and the drop is flagged so a renderer can say the diff is partial instead of
 * presenting it as the whole change.
 */
const MAX_PATCH_LINES = 400

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

/** Structural, not `instanceof`: this reads a field the SDK types as `unknown`,
 * and a shape check is the only honest way to know what arrived. */
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

/**
 * A {@link FilePatch} from the Claude SDK's structured tool output
 * (`SDKUserMessage.tool_use_result` for Edit/Write/NotebookEdit).
 *
 * Everything else on that object is deliberately left behind — `originalFile`
 * alone is the entire pre-edit file, which is precisely what must not be logged
 * (see `FilePatch`'s own note).
 */
export function filePatchFromToolResult(result: unknown): FilePatch | undefined {
  const output = result as
    | { filePath?: unknown; structuredPatch?: unknown; originalFile?: unknown; type?: unknown }
    | null
    | undefined
  if (!output || !Array.isArray(output.structuredPatch)) return undefined
  const hunks = output.structuredPatch.filter(isHunk)
  if (hunks.length === 0) return undefined
  const { hunks: kept, truncated } = capHunks(hunks)
  return {
    ...(typeof output.filePath === 'string' && { path: output.filePath }),
    // Write reports `type: 'create' | 'update'` directly. Edit has no such
    // field, but `originalFile` answers the same question: null means there was
    // no file to edit. Absent entirely (neither field) leaves `kind` unset
    // rather than assuming an update.
    ...(output.type === 'create' || output.originalFile === null
      ? ({ kind: 'create' } as const)
      : output.type === 'update' || typeof output.originalFile === 'string'
        ? ({ kind: 'update' } as const)
        : {}),
    hunks: kept,
    ...(truncated && { truncated }),
  }
}

/** `@@ -oldStart,oldLines +newStart,newLines @@` — the counts are optional and
 * mean 1 when absent, which is what a single-line hunk looks like. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * A {@link FilePatch} from a unified diff — codex's `fileChange.diff`.
 *
 * Only the hunks are read. A diff's `---`/`+++` header names the file, but codex
 * already reports the path on the change itself, and a header path is often
 * relative or `/dev/null`, so the caller's path is the one worth trusting.
 *
 * Returns undefined when there is no hunk header at all: that is not a unified
 * diff, and inventing hunk numbers for it would put wrong line numbers on screen
 * — worse than none.
 */
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
    if (!current) continue
    // Inside a hunk, a line belongs to it when it carries a diff prefix. A
    // '\' line ("\ No newline at end of file") is a note about the previous
    // line, not a line of the file, and is dropped.
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      current.lines.push(line)
    } else if (line === '') {
      // An empty line in a diff body is a context line whose trailing space was
      // stripped somewhere between the engine and here — common enough that
      // dropping it would silently shift every line number after it.
      current.lines.push(' ')
    } else {
      current = undefined
    }
  }
  if (hunks.length === 0) return undefined
  const { hunks: kept, truncated } = capHunks(hunks)
  return { ...(path && { path }), hunks: kept, ...(truncated && { truncated }) }
}
