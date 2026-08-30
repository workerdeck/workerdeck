import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { UseHostFileSearchResult, UseHostFileTreeResult } from '@workerdeck/react'
import type { HostDirEntry, HostFileMatch } from '@workerdeck/protocol'
import { ChevronRight, File, Folder, FolderOpen, Link2, PanelLeftClose, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Spinner } from '../ui/Spinner.tsx'

export interface FileTreeProps {
  /** Tree state from `useHostFileTree` — this component holds none of its own. */
  tree: UseHostFileTreeResult
  /** Optional search from `useHostFileSearch`; omit and the box is not offered. */
  search?: UseHostFileSearchResult
  /** Path of the focused file, highlighted in the tree. */
  activePath?: string
  onOpenFile: (path: string) => void
  /** Offered as a button in the header when given. */
  onCollapse?: () => void
  style?: CSSProperties
  className?: string
}

/** How far one level of nesting indents, in pixels. Inline rather than a Tailwind
 * class because depth is a number at runtime and `pl-${n}` is not a class. */
const INDENT = 12

/**
 * The workspace's left rail: an expandable tree of the session's project,
 * with a search box over the same fuzzy route `@file` completion uses.
 *
 * Presentational by construction — every piece of state it renders comes from
 * the hooks in `@workerdeck/react`, and the only thing it owns is the search
 * query, which is the text in its own input.
 *
 * Searching replaces the tree with matches rather than filtering it: the route
 * answers with paths from all over the project, and threading those back into
 * tree positions would mean expanding a dozen directories to show six results.
 */
export function FileTree({ tree, search, activePath, onOpenFile, onCollapse, style, className }: FileTreeProps) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<HostFileMatch[] | undefined>()
  const searching = query.trim().length > 0

  // Debounced, and only while there is something to search for — an empty box
  // means "show me the tree again", not "match everything".
  useEffect(() => {
    if (!search?.available) {
      return
    }
    const q = query.trim()
    if (!q) {
      setMatches(undefined)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void search.search(q, { limit: 60, signal: controller.signal }).then((found) => {
        if (!controller.signal.aborted) {
          setMatches(found)
        }
      })
    }, 150)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [search, query])

  return (
    <div data-slot="file-tree" style={style} className={cn('flex min-h-0 min-w-0 flex-col bg-surface', className)}>
      <div className="flex items-center gap-1 px-2 pt-2">
        {search?.available ? (
          <div className="relative min-w-0 flex-1">
            <Search className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-4" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search files…"
              className="h-7 pr-7 pl-7 text-label"
              spellCheck={false}
            />
            {searching ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 text-fg-4 transition-colors hover:text-fg-2"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-label text-fg-4">{tree.root}</span>
        )}
        <Button variant="ghost" size="icon-sm" aria-label="Refresh the file tree" onClick={() => tree.refresh()}>
          <RefreshCw className="size-3.5 text-fg-3" />
        </Button>
        {onCollapse ? (
          <Button variant="ghost" size="icon-sm" aria-label="Hide project files" onClick={onCollapse}>
            <PanelLeftClose className="size-3.5 text-fg-3" />
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {tree.error ? (
          <p className="px-2 py-3 text-body-sm text-danger">{tree.error}</p>
        ) : searching ? (
          matches === undefined ? (
            <div className="py-6 text-center">
              <Spinner className="size-4 text-fg-4" />
            </div>
          ) : matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-body-sm text-fg-4">No matching files.</p>
          ) : (
            <ul>
              {matches.map((match) => (
                <li key={match.path}>
                  <Row
                    label={fileName(match.relative)}
                    // The directory, dimmed and truncated separately, so a deep
                    // path cannot push the filename out of the row — a rail full
                    // of `apps/ios/DerivedData/B…` says nothing about which file
                    // each hit is.
                    detail={directoryOf(match.relative)}
                    title={match.relative}
                    icon={<File className="size-3.5 shrink-0 text-fg-4" />}
                    active={match.path === activePath}
                    onClick={() => onOpenFile(match.path)}
                  />
                </li>
              ))}
            </ul>
          )
        ) : tree.loading ? (
          <div className="py-6 text-center">
            <Spinner className="size-4 text-fg-4" />
          </div>
        ) : tree.rows.length === 0 ? (
          <p className="px-2 py-6 text-center text-body-sm text-fg-4">This project is empty.</p>
        ) : (
          <ul role="tree" aria-label="Project files">
            {tree.rows.map((row) => (
              <li key={row.entry.path} role="treeitem" aria-expanded={row.expanded} aria-level={row.depth + 1}>
                <Row
                  label={row.entry.name}
                  indent={row.depth}
                  active={row.entry.path === activePath}
                  icon={
                    row.entry.type === 'dir' ? (
                      row.loading ? (
                        <Spinner className="size-3.5 shrink-0 text-fg-4" />
                      ) : row.expanded ? (
                        <FolderOpen className="size-3.5 shrink-0 text-accent" />
                      ) : (
                        <Folder className="size-3.5 shrink-0 text-accent" />
                      )
                    ) : (
                      <EntryIcon type={row.entry.type} />
                    )
                  }
                  chevron={
                    row.entry.type === 'dir' ? (
                      <ChevronRight className={cn('size-3 shrink-0 text-fg-4 transition-transform', row.expanded && 'rotate-90')} />
                    ) : undefined
                  }
                  onClick={() => (row.entry.type === 'dir' ? tree.toggle(row.entry.path) : onOpenFile(row.entry.path))}
                />
                {row.truncated ? (
                  <p className="truncate py-0.5 text-label text-fg-4" style={{ paddingLeft: (row.depth + 1) * INDENT + 22 }}>
                    More entries than the server will return — use search.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

/** One clickable line. A directory and a file differ only in what the click does
 * and whether there is a chevron — visually they are the same row. */
function Row({
  label,
  detail,
  title,
  icon,
  chevron,
  indent = 0,
  active,
  onClick,
}: {
  label: string
  /** Secondary text after the label, dimmed and the first thing to be truncated. */
  detail?: string
  title?: string
  icon: ReactNode
  chevron?: ReactNode
  indent?: number
  active?: boolean
  onClick: () => void
}) {
  // Scroll a row that became active elsewhere (a search hit, a `reveal`) into
  // view, but never yank the list while someone is reading it — `nearest` moves
  // the minimum and does nothing when the row is already visible.
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [active])

  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={title ?? label}
      style={{ paddingLeft: indent * INDENT + 4 }}
      className={cn(
        'flex w-full items-center gap-1 rounded py-1 pr-2 text-left transition-colors',
        active ? 'bg-surface-hover text-fg-1' : 'text-fg-2 hover:bg-surface-hover',
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">{chevron}</span>
      {icon}
      {/* `shrink-0` on the name and `min-w-0` on the detail: when the row runs
          out of room the directory gives way and the filename stays whole.
          The rail reads in the **UI font**, never mono: it is workbench chrome
          — a list you scan — and the editors it sits beside (VS Code, Finder)
          all set filenames in their UI face. Mono is for content on a grid, and
          nothing here is on one. It is also independent of `transcriptFont`,
          which scopes to the session panel alone. */}
      <span className="shrink-0 truncate text-label">{label}</span>
      {detail ? <span className="min-w-0 flex-1 truncate text-label text-fg-4">{detail}</span> : null}
    </button>
  )
}

/** Last segment of a relative match. */
function fileName(relative: string): string {
  return relative.slice(relative.lastIndexOf('/') + 1)
}

/** Everything before it, or `undefined` for a file at the search root. */
function directoryOf(relative: string): string | undefined {
  const cut = relative.lastIndexOf('/')
  return cut === -1 ? undefined : relative.slice(0, cut)
}

/** A symlink is reported as itself and never silently resolved — following it is
 * the next request's problem, and that request is refused if it escapes the roots. */
function EntryIcon({ type }: { type: HostDirEntry['type'] }) {
  if (type === 'symlink') {
    return <Link2 className="size-3.5 shrink-0 text-fg-4" />
  }
  return <File className="size-3.5 shrink-0 text-fg-4" />
}
