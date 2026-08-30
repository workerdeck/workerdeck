/**
 * How much of a tool result a collapsed row shows, and what it says it hid.
 * Pure and its own module because two consumers must agree to the character:
 * `items.tsx` draws these rows and `height.ts` wraps these exact strings to
 * predict their pixel height without a DOM.
 *
 * Two budgets, not one: a one-line minified JSON blob defeats a line budget
 * (all 30k characters "fit" in one line, and `hidden` counts zero), while a
 * character budget alone cuts ordinary short-line results for no reason. A
 * first line longer than the character budget is truncated rather than shown
 * whole — a row has to show something.
 */

// At most this many lines however short they are, and at most this many
// characters — roughly four lines at a realistic terminal width.
const PREVIEW_LINES = 4
const PREVIEW_CHARS = 400

export type CollapsedResult = {
  /** The lines to draw. The last may be truncated (it ends in `…`). */
  shown: string[]
  /**
   * The trailing "there is more" row, already spelled. A string rather than a
   * count: `height.ts` wraps this exact text, and two spellings would be two
   * different heights.
   */
  more?: string
}

/**
 * `totalChars` is the untruncated length when the replay delivered only a head
 * (protocol's `ToolResultBlock.total_chars`). It changes the "+N chars" string,
 * and thereby the row's predicted height — omit it only for a whole result.
 * Hidden amounts are reported in characters when the cut happened inside a
 * line, in lines otherwise.
 */
export const collapsedResult = (lines: string[], totalChars?: number): CollapsedResult => {
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
    if (shown.length > 0 && chars + line.length > PREVIEW_CHARS) {
      break
    }
    shown.push(line)
    chars += line.length + 1
  }

  // `totalChars` wins when it exists: the lines in hand are then only a head.
  const held = lines.join('\n').length
  const total = totalChars ?? held
  if (cut) {
    return { shown, more: `… +${(total - chars).toLocaleString()} chars` }
  }
  // A truncated result always has more, even when its head fit the line
  // budget: the row must never claim to be showing everything.
  if (totalChars !== undefined && total > held) {
    return { shown, more: `… +${(total - chars).toLocaleString()} chars` }
  }
  const hidden = lines.length - shown.length
  return { shown, more: hidden > 0 ? `… +${hidden} line${hidden === 1 ? '' : 's'}` : undefined }
}
