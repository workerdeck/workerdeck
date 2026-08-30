import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { isDirty, type OpenFile } from '@workerdeck/react'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Tip, TooltipProvider } from '../ui/Tooltip.tsx'
import { formatBytes } from '../../lib/format.ts'

export interface EditorTabsProps {
  files: OpenFile[]
  activePath?: string
  onActivate: (path: string) => void
  onClose: (path: string) => void
  className?: string
}

/**
 * The open-file tab strip. Hand-rolled rather than built on `@base-ui/react`'s
 * `Tabs`: a tab carries a close button, and a `<button>` inside a `<button>` is
 * invalid HTML. State-free — `useOpenFiles` decides everything it renders.
 */
export function EditorTabs({ files, activePath, onActivate, onClose, className }: EditorTabsProps) {
  return (
    // Grouped, so moving along the strip shows each tab's path immediately.
    <TooltipProvider delay={500} closeDelay={0}>
      <div
        data-slot="editor-tabs"
        role="tablist"
        aria-label="Open files"
        className={cn('flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface', className)}
      >
        {files.map((file) => (
          <Tab
            key={file.path}
            file={file}
            active={file.path === activePath}
            onActivate={() => onActivate(file.path)}
            onClose={() => onClose(file.path)}
            onArrow={(direction) => {
              const index = files.findIndex((f) => f.path === file.path)
              const next = files[index + direction]
              if (next) {
                onActivate(next.path)
              }
            }}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}

const Tab = ({
  file,
  active,
  onActivate,
  onClose,
  onArrow,
}: {
  file: OpenFile
  active: boolean
  onActivate: () => void
  onClose: () => void
  onArrow: (direction: 1 | -1) => void
}) => {
  const dirty = isDirty(file)
  const ref = useRef<HTMLDivElement>(null)
  // `nearest` scrolls the minimum, so a tab already on screen does not move.
  useEffect(() => {
    if (active) {
      ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
  }, [active])

  const onAuxClick = (event: ReactMouseEvent) => {
    // `auxclick` rather than `mousedown`, matching the platform's other
    // middle-click targets.
    if (event.button !== 1) {
      return
    }
    event.preventDefault()
    onClose()
  }

  return (
    // The tab *is* the trigger (`render`) and carries the full path. No `title`
    // alongside it — the native tooltip would show up underneath this one.
    <Tip
      side="bottom"
      render={
        <div
          ref={ref}
          role="tab"
          tabIndex={active ? 0 : -1}
          aria-selected={active}
          onClick={onActivate}
          onAuxClick={onAuxClick}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              onArrow(1)
            } else if (event.key === 'ArrowLeft') {
              onArrow(-1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              onActivate()
            } else {
              return
            }
            event.preventDefault()
          }}
          className={cn(
            'group flex min-w-0 shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-1.5 transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset',
            active ? 'bg-bg text-fg-1' : 'text-fg-3 hover:bg-surface-hover hover:text-fg-2',
          )}
        />
      }
      content={
        <span className="flex flex-col gap-0.5">
          <span className="font-mono break-all">{file.path}</span>
          {file.bytes !== undefined ? <span className="text-fg-4">{formatBytes(file.bytes)}</span> : null}
        </span>
      }
    >
      <span className={cn('max-w-40 truncate font-mono text-label', dirty && 'italic')}>{file.name}</span>
      {/* Errors are the one state the strip shows: a failed tab otherwise looks
          identical to a loaded one until you focus it. */}
      {file.status === 'error' ? <span className="shrink-0 text-danger">!</span> : null}
      <button
        type="button"
        aria-label={dirty ? `Close ${file.name} (unsaved changes)` : `Close ${file.name}`}
        onClick={(event) => {
          // Otherwise the click also activates the tab being closed, fighting
          // the reducer's focus-the-neighbour rule.
          event.stopPropagation()
          onClose()
        }}
        className={cn(
          'shrink-0 rounded p-0.5 text-fg-4 transition-opacity hover:bg-surface-hover hover:text-fg-1',
          // Always reachable by keyboard and on touch; only *shown* on hover.
          active || dirty ? 'opacity-70' : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100',
        )}
      >
        {/* A dirty tab shows a dot where the ✕ goes; the ✕ returns on hover. */}
        <span className={cn('block', dirty && 'group-hover:hidden')}>
          {dirty ? <span className="block size-3 rounded-full bg-fg-2" /> : <X className="size-3" />}
        </span>
        {dirty ? (
          <span className="hidden group-hover:block">
            <X className="size-3" />
          </span>
        ) : null}
      </button>
    </Tip>
  )
}
