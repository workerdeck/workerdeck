/**
 * "Is this text a file path" — one answer for both the Cmd/Ctrl+click and the
 * hold-to-highlight, so nothing lights up that a click would ignore.
 *
 * Two shapes, and the second is why this is not a one-line regex. An **absolute**
 * path (`/a/b.ts`, `./a/b.ts`, `../a/b.ts`) is unambiguous. A **relative** one
 * (`_docs/BACKLOG.md`) is not — `and/or` and `TypeScript/JavaScript` have the
 * same shape — so a relative match additionally has to end in something that
 * looks like a filename with an extension. Without that the modifier would
 * underline half of ordinary prose and every click would end in a warning.
 *
 * The match must also start at a **token boundary**. The old pattern required a
 * leading `/` and was unanchored, so `@_docs/BACKLOG.md` matched the *suffix*
 * `/BACKLOG.md` and the extension confidently tried to open a file at the
 * filesystem root. Anchoring is the whole fix for that; the relative branch is
 * what makes the intended path openable.
 */

/** One path segment: no whitespace, no separator, none of the characters that
 * bracket a path in prose. `:` is out because it introduces `:line`. */
const SEG = "[^\\s:'\"`()\\[\\]{}<>|]+"

/** The *first* segment of a relative path additionally cannot start with `@`:
 * an `@file` mention is written `@_docs/BACKLOG.md`, and the `@` is the
 * mention's sigil, not part of the name. */
const HEAD = "[^\\s:'\"`()\\[\\]{}<>|@,]+"

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
  if (!match) return undefined
  const path = match[1].replace(TRAILING, '')
  if (!path.includes('/')) return undefined
  const rooted = path.startsWith('/') || path.startsWith('./') || path.startsWith('../')
  if (!rooted && !FILENAME.test(path)) return undefined
  const line = match[2] ? Number(match[2]) : undefined
  return { path, line, length: path.length + (match[2]?.length ?? -1) + 1 }
}
