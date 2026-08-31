import { useEffect, type RefObject } from 'react'

export type PathHit = { path: string; line?: number }

const LINKISH = 'wd-path-link'

const PATH_RE = /^(\/[^\s:'"`()[\]{}]+|[\w.@~-]+(?:\/[\w.@~-]+)+)(?::(\d+))?$/
const FILE_RE = /^([\w.@-]+\.[A-Za-z0-9]{1,10})(?::(\d+))?$/

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
  container: RefObject<HTMLElement | null>
  onOpen: (hit: PathHit) => void
  enabled?: boolean
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

export const resolveAgainstCwd = (path: string, cwd: string | undefined): string => {
  if (path.startsWith('/')) {
    return path
  }
  if (!cwd) {
    return path
  }
  return `${cwd.replace(/\/$/, '')}/${path.replace(/^\.\//, '')}`
}
