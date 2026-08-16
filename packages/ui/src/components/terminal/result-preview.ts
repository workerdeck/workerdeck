/**
 * How much of a tool result a collapsed row shows, and what it says it hid.
 *
 * Its own module, and pure, because **two** consumers must agree on it to the
 * character: `items.tsx` draws these rows, and `height.ts` predicts their pixel
 * height for the virtualizer's `estimateSize` without a DOM. The budget used to
 * be a private constant in `items.tsx` restated as a copy in `height.ts` with a
 * comment admitting the drift risk — this is that comment's fix.
 *
 * **Two budgets, not one.** Lines alone was the old rule and it has an exact
 * blind spot: a minified JSON reply — which is every MCP tool's reply — is ONE
 * line, so a four-line slice kept all thirty thousand characters of it and the
 * row wrapped to a screenful. `hidden` was computed as `lines.length -
 * shown.length`, so it came out zero and the row did not even offer the "+N"
 * affordance: the whole blob was simply the transcript now. Characters alone
 * would be wrong the other way, cutting an ordinary short-line result mid-way
 * for no reason. So both apply, and a *first* line longer than the budget is
 * truncated rather than shown whole — a row has to show something or it opens
 * onto nothing.
 */

/** At most this many lines, however short they are. */
const PREVIEW_LINES = 4
/**
 * …and at most this many characters, however few lines they are. Four lines'
 * worth at any realistic terminal width — the row is indented six cells, so a
 * 100ch panel fits ~94 per line — which keeps the budget honest whether the
 * result arrives as four lines or as one long one.
 */
const PREVIEW_CHARS = 400

export type CollapsedResult = {
  /** The lines to draw. The last may be truncated (it ends in `…`). */
  shown: string[]
  /**
   * The trailing "there is more" row, already spelled. The *string* rather than
   * a count, because `height.ts` wraps this exact text to size the row, and two
   * spellings would be two different heights.
   */
  more?: string
}

/**
 * Reported in characters when the truncation happened *inside* a line and in
 * lines otherwise — a one-line JSON blob has no hidden lines to count, and
 * "+0 lines" under a visibly cut-off row is worse than saying nothing.
 */
export function collapsedResult(lines: string[]): CollapsedResult {
  const shown: string[] = []
  let chars = 0
  let cut = false

  for (const line of lines.slice(0, PREVIEW_LINES)) {
    if (shown.length === 0 && line.length > PREVIEW_CHARS) {
      shown.push(`${line.slice(0, PREVIEW_CHARS)}…`)
      chars = PREVIEW_CHARS
      cut = true
      break
    }
    if (shown.length > 0 && chars + line.length > PREVIEW_CHARS) break
    shown.push(line)
    chars += line.length + 1
  }

  if (cut) {
    // `join` because the newlines are part of what is not being shown.
    const hidden = lines.join('\n').length - chars
    return { shown, more: `… +${hidden.toLocaleString()} chars` }
  }
  const hidden = lines.length - shown.length
  return { shown, more: hidden > 0 ? `… +${hidden} line${hidden === 1 ? '' : 's'}` : undefined }
}
