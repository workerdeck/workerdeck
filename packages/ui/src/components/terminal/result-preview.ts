const PREVIEW_LINES = 4
const PREVIEW_CHARS = 400

export type CollapsedResult = {
  shown: string[]
  more?: string
}

export function collapsedResult(lines: string[], totalChars?: number): CollapsedResult {
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

  const held = lines.join('\n').length
  const total = totalChars ?? held
  if (cut) {
    return { shown, more: `… +${(total - chars).toLocaleString()} chars` }
  }
  if (totalChars !== undefined && total > held) {
    return { shown, more: `… +${(total - chars).toLocaleString()} chars` }
  }
  const hidden = lines.length - shown.length
  return { shown, more: hidden > 0 ? `… +${hidden} line${hidden === 1 ? '' : 's'}` : undefined }
}
