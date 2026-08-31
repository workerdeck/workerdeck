import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { UseHostFileSearchResult, UseHostFileTreeResult } from '@workerdeck/react'
import type { HostDirEntry, HostFileMatch } from '@workerdeck/protocol'
import { ChevronRight, File, Folder, FolderOpen, Link2, PanelLeftClose, RefreshCw, Search, X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Spinner } from '../ui/Spinner.tsx'

export interface FileTreeProps {
  tree: UseHostFileTreeResult
  search?: UseHostFileSearchResult
  activePath?: string
  onOpenFile: (path: string) => void
  onCollapse?: () => void
  style?: CSSProperties
  className?: string
}

const INDENT = 12

export function FileTree({ tree, search, activePath, onOpenFile, onCollapse, style, className }: FileTreeProps) {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<HostFileMatch[] | undefined>()
  const searching = query.trim().length > 0

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

const Row = ({
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
  detail?: string
  title?: string
  icon: ReactNode
  chevron?: ReactNode
  indent?: number
  active?: boolean
  onClick: () => void
}) => {
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
      <span className="shrink-0 truncate text-label">{label}</span>
      {detail ? <span className="min-w-0 flex-1 truncate text-label text-fg-4">{detail}</span> : null}
    </button>
  )
}

const fileName = (relative: string): string => relative.slice(relative.lastIndexOf('/') + 1)

const directoryOf = (relative: string): string | undefined => {
  const cut = relative.lastIndexOf('/')
  return cut === -1 ? undefined : relative.slice(0, cut)
}

const EntryIcon = ({ type }: { type: HostDirEntry['type'] }) => {
  if (type === 'symlink') {
    return <Link2 className="size-3.5 shrink-0 text-fg-4" />
  }
  return <File className="size-3.5 shrink-0 text-fg-4" />
}
