// One path segment: no whitespace, no separator, none of the characters that bracket a path in
// prose. `:` is out because it introduces `:line`.
const SEG = '[^\\s:\'"`()\\[\\]{}<>|]+'

// The first segment of a relative path additionally cannot start with `@`: in an `@file` mention
// (`@_docs/BACKLOG.md`) the `@` is the mention's sigil, not part of the name.
const HEAD = '[^\\s:\'"`()\\[\\]{}<>|@,]+'

// The match must start at a token boundary, never consumed into the path: unanchored,
// `@_docs/BACKLOG.md` matched the suffix `/BACKLOG.md` and opened at the filesystem root.
const PATH_PATTERN = new RegExp(`(?:^|[\\s'"\`([{<@,])((?:\\.\\.?)?(?:/${SEG})+|${HEAD}(?:/${SEG})+)(?::(\\d+))?`)

const FILE_PATTERN = /^([\w.@-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?$/

const TRAILING = /[.,;:!?)\]}'"`]+$/

const FILENAME = /\.[A-Za-z0-9]{1,10}$/

export type PathHit = { path: string; line?: number }

export type PathMatch = PathHit & {
  // How much of the inspected text the path accounted for, the "mostly a path" test the hover makes.
  length: number
}

export function matchPath(text: string | null | undefined, inCode = false): PathMatch | undefined {
  const source = text ?? ''
  const match = PATH_PATTERN.exec(source)
  if (!match) {
    return inCode ? matchFilename(source) : undefined
  }
  const path = match[1]!.replace(TRAILING, '')
  if (!path.includes('/') || path.endsWith('/')) {
    return undefined
  }
  const rooted = path.startsWith('/') || path.startsWith('./') || path.startsWith('../')
  if (!rooted && !FILENAME.test(path)) {
    return undefined
  }
  const line = match[2] ? Number(match[2]) : undefined
  return { path, line, length: path.length + (match[2] ? match[2].length + 1 : 0) }
}

function matchFilename(text: string): PathMatch | undefined {
  const hit = FILE_PATTERN.exec(text.trim())
  if (!hit) {
    return undefined
  }
  const line = hit[2] ? Number(hit[2]) : undefined
  return { path: hit[1]!, line, length: hit[0].length }
}
