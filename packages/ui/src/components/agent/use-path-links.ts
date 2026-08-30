import { useEffect, type RefObject } from 'react'

/**
 * Cmd/Ctrl+click a file path in the transcript to open it.
 *
 * **Detection is deliberately conservative**, because the cost is asymmetric —
 * a false positive teaches the reader not to trust any of the links:
 *
 * - A trailing `/` means a directory, which is not openable.
 * - Outside a `<code>` element the match must cover most of what the element
 *   says ({@link COVERAGE}), or a paragraph mentioning a path in passing would
 *   underline whole sentences.
 * - A bare filename is only a path **inside code**, and only with an extension.
 */
export type PathHit = { path: string; line?: number }

/** Marks the element under the pointer while the modifier is held. */
const LINKISH = 'wd-path-link'

/** Absolute, or relative with at least one separator. `:12` is a line number. */
const PATH_RE = /^(\/[^\s:'"`()[\]{}]+|[\w.@~-]+(?:\/[\w.@~-]+)+)(?::(\d+))?$/
/** A bare filename — only trusted inside a code element. */
const FILE_RE = /^([\w.@-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?$/

/** How much of an element's text the match must cover, outside code. */
const COVERAGE = 0.6

export const matchPath = (text: string, inCode: boolean): PathHit | undefined => {
  const trimmed = text.trim()
  if (!trimmed || trimmed.endsWith('/')) {
    return undefined
  }
  const hit = PATH_RE.exec(trimmed) ?? (inCode ? FILE_RE.exec(trimmed) : null)
  if (!hit) {
    return undefined
  }
  return { path: hit[1]!, line: hit[2] ? Number(hit[2]) : undefined }
}

/** The path a click on this element means, if any. */
const hitFor = (element: HTMLElement | undefined): PathHit | undefined => {
  if (!element) {
    return undefined
  }
  const inCode = element.closest('code') !== null
  const text = element.textContent ?? ''
  const hit = matchPath(text, inCode)
  if (!hit) {
    return undefined
  }
  if (!inCode && hit.path.length < text.trim().length * COVERAGE) {
    return undefined
  }
  return hit
}

export const usePathLinks = ({
  container,
  onOpen,
  enabled = true,
  ignore,
}: {
  /** The subtree to listen in — normally the panel. */
  container: RefObject<HTMLElement | null>
  onOpen: (hit: PathHit) => void
  /** Off when there is no host filesystem to open from: a link that cannot
   * resolve is worse than plain text. */
  enabled?: boolean
  /**
   * A selector for subtrees to leave alone. Anything with its own meaning for
   * the modifier needs this — a code editor's Cmd+click is go-to-definition,
   * and every identifier in it would otherwise match as a filename.
   */
  ignore?: string
}) => {
  useEffect(() => {
    const root = container.current
    if (!root || !enabled) {
      return
    }
    const excluded = (element: HTMLElement | undefined) =>
      ignore !== undefined && element?.closest(ignore) !== null && element !== undefined

    let marked: HTMLElement | undefined
    const unmark = () => {
      marked?.classList.remove(LINKISH)
      marked = undefined
    }

    const onClick = (event: MouseEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        return
      }
      const target = event.target instanceof HTMLElement ? event.target : undefined
      if (excluded(target)) {
        return
      }
      const hit = hitFor(target)
      if (!hit) {
        return
      }
      // Capture phase and stopped here: the row underneath is usually
      // pressable, and opening a file is not expanding it.
      event.preventDefault()
      event.stopPropagation()
      unmark()
      onOpen(hit)
    }

    const onMove = (event: MouseEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        return unmark()
      }
      const element = event.target instanceof HTMLElement ? event.target : undefined
      if (element === marked) {
        return
      }
      unmark()
      if (!element || excluded(element) || !hitFor(element)) {
        return
      }
      marked = element
      element.classList.add(LINKISH)
    }

    // Releasing the modifier must clear the mark: an underline that outlives
    // the key promises a click that will not work.
    const onKey = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        unmark()
      }
    }

    root.addEventListener('click', onClick, true)
    root.addEventListener('mousemove', onMove)
    document.addEventListener('keydown', onKey)
    document.addEventListener('keyup', onKey)
    window.addEventListener('blur', unmark)
    return () => {
      unmark()
      root.removeEventListener('click', onClick, true)
      root.removeEventListener('mousemove', onMove)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', unmark)
    }
  }, [container, onOpen, enabled, ignore])
}

/** A transcript path against the session's cwd — the only root that makes a
 * bare `worker.mjs` mean anything. */
export const resolveAgainstCwd = (path: string, cwd: string | undefined): string => {
  if (path.startsWith('/')) {
    return path
  }
  if (!cwd) {
    return path
  }
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}
