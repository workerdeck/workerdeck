import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveBundledRipgrep } from '@workerdeck/core'
import {
  HOST_SEARCH_MAX_RESULTS,
  type HostSearchEvent,
  type HostSearchFile,
  type HostSearchLine,
  type HostSearchMatch,
  type HostSearchRequest,
} from '@workerdeck/protocol'

export type TextSearchQuery = Omit<HostSearchRequest, 'path'>

type RgText = { text?: string; bytes?: string }

type RgMessage =
  | { type: 'begin'; data: { path: RgText } }
  | { type: 'match'; data: { path: RgText; lines: RgText; line_number: number | null; submatches: { start: number; end: number }[] } }
  | { type: 'end'; data: { path: RgText } }
  | { type: string; data?: unknown }

const PREVIEW_LEAD = 40
const PREVIEW_CHARS = 400
const STDERR_BYTES = 4096
const RUST_REGEX_META = /[\\.+*?()|[\]{}^$#&\-~]/g

export function resolveRipgrep(override?: string | false): string | undefined {
  if (override === false) {
    return undefined
  }
  if (override) {
    return override
  }
  const bundled = resolveBundledRipgrep()
  if (bundled) {
    return bundled
  }
  const name = process.platform === 'win32' ? 'rg.exe' : 'rg'
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) {
      continue
    }
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) {
        return candidate
      }
    } catch {}
  }
  return undefined
}

export function ripgrepArgs(query: TextSearchQuery): string[] {
  const multiline = query.query.includes('\n') || (query.isRegex === true && query.query.includes('\\n'))
  const args = ['--json', '--no-config', '--no-messages', '--hidden', '--no-ignore-parent', '--no-ignore-global']
  if (query.useIgnoreFiles === false) {
    args.push('--no-ignore')
  }
  args.push(query.matchCase ? '--case-sensitive' : '--ignore-case')
  if (query.wholeWord) {
    args.push('--word-regexp')
  }
  let pattern = query.query
  if (multiline) {
    args.push('--multiline')
    if (!query.isRegex) {
      pattern = pattern.replace(RUST_REGEX_META, '\\$&')
    }
  } else if (!query.isRegex) {
    args.push('--fixed-strings')
  }
  if (query.isRegex) {
    args.push('--engine', 'auto')
  }
  for (const glob of query.includes ?? []) {
    args.push('--glob', glob)
  }
  for (const glob of query.excludes ?? []) {
    args.push('--glob', `!${glob}`)
  }
  args.push('--regexp', pattern, '--', '.')
  return args
}

export async function* searchText(rg: string, base: string, query: TextSearchQuery, signal: AbortSignal): AsyncGenerator<HostSearchEvent> {
  const limit = Math.min(Math.max(1, query.maxResults ?? HOST_SEARCH_MAX_RESULTS), HOST_SEARCH_MAX_RESULTS)
  const child = spawn(rg, ripgrepArgs(query), { cwd: base, stdio: ['ignore', 'pipe', 'pipe'] })
  const stop = (): void => {
    child.kill()
  }
  signal.addEventListener('abort', stop, { once: true })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(0, STDERR_BYTES)
  })
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1))
    child.once('close', (code) => resolve(code))
  })
  let files = 0
  let matches = 0
  let truncated = false
  let current: HostSearchFile | undefined
  try {
    for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (signal.aborted) {
        return
      }
      let message: RgMessage
      try {
        message = JSON.parse(raw) as RgMessage
      } catch {
        continue
      }
      if (message.type === 'begin') {
        const relative = relativeOf((message as Extract<RgMessage, { type: 'begin' }>).data.path)
        current = relative === undefined ? undefined : { type: 'file', path: join(base, relative), relative, lines: [] }
        continue
      }
      if (message.type === 'match' && current) {
        const data = (message as Extract<RgMessage, { type: 'match' }>).data
        const line = searchLine(data.lines, data.line_number, data.submatches, limit - matches)
        if (line) {
          current.lines.push(line)
          matches += line.matches.length
        }
        if (matches >= limit) {
          truncated = true
          yield current
          files++
          current = undefined
          child.kill()
          break
        }
        continue
      }
      if (message.type === 'end' && current) {
        if (current.lines.length > 0) {
          yield current
          files++
        }
        current = undefined
      }
    }
    const code = await exited
    if (signal.aborted) {
      return
    }
    if (!truncated && (code === 2 || code === -1) && matches === 0) {
      yield { type: 'error', message: failureText(stderr, code) }
      return
    }
    yield { type: 'done', files, matches, truncated }
  } finally {
    signal.removeEventListener('abort', stop)
    if (child.exitCode === null) {
      child.kill()
    }
  }
}

function relativeOf(path: RgText): string | undefined {
  if (path.text === undefined) {
    return undefined
  }
  return path.text.startsWith('./') ? path.text.slice(2) : path.text
}

function searchLine(
  lines: RgText,
  lineNumber: number | null,
  submatches: { start: number; end: number }[],
  room: number,
): HostSearchLine | undefined {
  if (lines.text === undefined || lineNumber === null || submatches.length === 0 || room <= 0) {
    return undefined
  }
  const bytes = Buffer.from(lines.text, 'utf8')
  const first = lineNumber - 1
  const matches: HostSearchMatch[] = submatches.slice(0, room).map(({ start, end }) => {
    const from = position(bytes, start)
    const to = position(bytes, end)
    return {
      line: first + from.line,
      column: from.column,
      endLine: first + to.line,
      endColumn: to.column,
      text: bytes.subarray(start, end).toString('utf8'),
    }
  })
  const firstLine = lines.text.split('\n', 1)[0]!.replace(/\r$/, '')
  const anchor = matches[0]!.line === first ? matches[0]!.column : 0
  let start = Math.max(0, anchor - PREVIEW_LEAD)
  if (start > 0 && isLowSurrogate(firstLine.charCodeAt(start))) {
    start--
  }
  let end = Math.min(firstLine.length, start + PREVIEW_CHARS)
  if (end < firstLine.length && isLowSurrogate(firstLine.charCodeAt(end))) {
    end++
  }
  return { line: first, start, text: firstLine.slice(start, end), matches }
}

function position(bytes: Buffer, offset: number): { line: number; column: number } {
  const before = bytes.subarray(0, offset).toString('utf8')
  const lastBreak = before.lastIndexOf('\n')
  let line = 0
  for (let i = before.indexOf('\n'); i !== -1; i = before.indexOf('\n', i + 1)) {
    line++
  }
  return { line, column: before.length - lastBreak - 1 }
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function failureText(stderr: string, code: number | null): string {
  const text = stderr.replace(/^rg: /gm, '').trim()
  if (text) {
    return text
  }
  return code === -1 ? 'ripgrep could not be started' : 'search failed'
}
