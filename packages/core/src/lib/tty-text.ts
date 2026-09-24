export type HeadTailOptions = { headLines: number; headChars: number; tailLines: number; tailChars: number }

export type HeadTail = { head: string; tail: string; omittedLines: number; totalLines: number; totalBytes: number }

type Taken = { text: string; lines: number }

const OSC_SEQUENCE = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g
const STRING_SEQUENCE = /(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c)/g
const CSI_SEQUENCE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g
const ESCAPE_SEQUENCE = /\x1b[ -/]*[0-~]/g
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g

// Alternate screen, cursor up or previous line, or an absolute row: a program that redraws, which a flattened
// transcript turns into every frame it ever painted. `\r` and erase-line are not here: a one-line progress bar
// flattens fine.
const REDRAW_SEQUENCE = /(?:\x1b\[|\x9b)(?:\?(?:1049|1047|47)h|\d*[AF]|\d+;\d+[Hf]|\d+d)/

export const TTY_REDRAW_CARRY = 16

export function ttyText(raw: string): string {
  const plain = raw
    .replace(OSC_SEQUENCE, '')
    .replace(STRING_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESCAPE_SEQUENCE, '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n/g, '\n')
  return plain
    .split('\n')
    .map((line) => overwritten(line).trimEnd())
    .join('\n')
}

export function ttyRedraws(raw: string): boolean {
  return REDRAW_SEQUENCE.test(raw)
}

export function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

export function countLines(text: string): number {
  if (text === '') {
    return 0
  }
  let count = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) {
    count++
  }
  return text.endsWith('\n') ? count - 1 : count
}

export function headTail(text: string, opts: HeadTailOptions): HeadTail {
  const lines = splitLines(text)
  const totalLines = lines.length
  const totalBytes = Buffer.byteLength(text, 'utf8')
  const body = lines.join('\n')
  if (totalLines <= opts.headLines + opts.tailLines && body.length <= opts.headChars + opts.tailChars) {
    return { head: body, tail: '', omittedLines: 0, totalLines, totalBytes }
  }
  const tail = takeTail(lines, Math.min(opts.tailLines, totalLines), opts.tailChars)
  const head = takeHead(lines, Math.min(opts.headLines, totalLines - tail.lines), opts.headChars)
  return { head: head.text, tail: tail.text, omittedLines: totalLines - head.lines - tail.lines, totalLines, totalBytes }
}

function overwritten(line: string): string {
  if (!line.includes('\r')) {
    return line
  }
  const segments = line.split('\r')
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== '') {
      return segments[i]!
    }
  }
  return ''
}

function takeHead(lines: readonly string[], maxLines: number, maxChars: number): Taken {
  let taken = 0
  let length = 0
  while (taken < maxLines) {
    const next = length + lines[taken]!.length + (taken > 0 ? 1 : 0)
    if (next > maxChars) {
      break
    }
    length = next
    taken++
  }
  if (taken === 0) {
    return { text: maxLines > 0 ? lines[0]!.slice(0, maxChars) : '', lines: 0 }
  }
  return { text: lines.slice(0, taken).join('\n'), lines: taken }
}

function takeTail(lines: readonly string[], maxLines: number, maxChars: number): Taken {
  let taken = 0
  let length = 0
  while (taken < maxLines) {
    const next = length + lines[lines.length - 1 - taken]!.length + (taken > 0 ? 1 : 0)
    if (next > maxChars) {
      break
    }
    length = next
    taken++
  }
  if (taken === 0) {
    const last = lines[lines.length - 1]!
    return { text: maxLines > 0 && maxChars > 0 ? last.slice(-maxChars) : '', lines: 0 }
  }
  return { text: lines.slice(lines.length - taken).join('\n'), lines: taken }
}
