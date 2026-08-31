// One path segment: no whitespace, no separator, none of the characters that
// bracket a path in prose. `:` is out because it introduces `:line`.
const SEG = '[^\\s:\'"`()\\[\\]{}<>|]+'

// The first segment of a relative path additionally cannot start with `@`: in an `@file` mention
// (`@_docs/BACKLOG.md`) the `@` is the mention's sigil, not part of the name.
const HEAD = '[^\\s:\'"`()\\[\\]{}<>|@,]+'

const PATH_PATTERN = new RegExp(
  // A token boundary (or the start), never consumed into the path.
  `(?:^|[\\s'"\`([{<@,])` +
    // Absolute, dot-relative, or bare relative — the last validated below.
    `((?:\\.\\.?)?(?:/${SEG})+|${HEAD}(?:/${SEG})+)` +
    `(?::(\\d+))?`,
)

const TRAILING = /[.,;:!?)\]}'"`]+$/

const FILENAME = /\.[A-Za-z0-9]{1,10}$/

export type PathMatch = {
  path: string
  line?: number
  // How much of the inspected text the path accounted for — the "mostly-a-path" test the hover affordance makes.
  length: number
}

export function matchPath(text: string | null | undefined): PathMatch | undefined {
  const match = PATH_PATTERN.exec(text ?? '')
  if (!match) {
    return undefined
  }
  const path = match[1].replace(TRAILING, '')
  if (!path.includes('/')) {
    return undefined
  }
  const rooted = path.startsWith('/') || path.startsWith('./') || path.startsWith('../')
  if (!rooted && !FILENAME.test(path)) {
    return undefined
  }
  const line = match[2] ? Number(match[2]) : undefined
  return { path, line, length: path.length + (match[2]?.length ?? -1) + 1 }
}
