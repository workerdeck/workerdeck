/**
 * "Is this text a file path" — one answer for both the Cmd/Ctrl+click and the
 * hold-to-highlight, so nothing lights up that a click would ignore.
 *
 * Two rules the regex cannot explain itself. A match must start at a **token
 * boundary**: unanchored, `@_docs/BACKLOG.md` matches the suffix `/BACKLOG.md` and
 * the host opens a file at the filesystem root. And a **relative** match must end
 * in a filename-with-extension, or `and/or` underlines as a path.
 */

/** One path segment: no whitespace, no separator, none of the characters that
 * bracket a path in prose. `:` is out because it introduces `:line`. */
const SEG = '[^\\s:\'"`()\\[\\]{}<>|]+'

/** The *first* segment of a relative path additionally cannot start with `@`:
 * an `@file` mention is written `@_docs/BACKLOG.md`, and the `@` is the
 * mention's sigil, not part of the name. */
const HEAD = '[^\\s:\'"`()\\[\\]{}<>|@,]+'

const PATH_PATTERN = new RegExp(
  // token boundary (or start) — never consumed into the path
  `(?:^|[\\s'"\`([{<@,])` +
    // absolute / dot-relative, or bare relative (validated below)
    `((?:\\.\\.?)?(?:/${SEG})+|${HEAD}(?:/${SEG})+)` +
    `(?::(\\d+))?`,
)

/** Trailing sentence punctuation is never part of the path. */
const TRAILING = /[.,;:!?)\]}'"`]+$/

/** A relative path has to end in a filename-with-extension to be believable. */
const FILENAME = /\.[A-Za-z0-9]{1,10}$/

export type PathMatch = {
  /** The path exactly as written — relative paths are resolved host-side, where
   * the session's cwd is known. */
  path: string
  line?: number
  /** How much of the inspected text the path accounted for, for the
   * "mostly-a-path" test the hover affordance makes. */
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
