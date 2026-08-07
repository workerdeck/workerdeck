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
 * The open-file tab strip.
 *
 * Hand-rolled rather than built on `@base-ui/react`'s `Tabs`: a VS Code tab
 * carries a close button, and a `<button>` inside a `<button>` is invalid HTML —
 * getting the primitive to render something else costs more than the roving
 * tabindex it would have provided. So that part is here, explicitly, along with
 * the two affordances that actually make a tab strip feel right: middle-click to
 * close, and the active tab scrolling itself into view.
 *
 * Deliberately state-free. Which files are open, which is focused and what
 * closing does are all decided by `useOpenFiles`.
 */
export function EditorTabs({ files, activePath, onActivate, onClose, className }: EditorTabsProps) {
  return (
    // Grouped, so moving along the strip shows each tab's path immediately
    // instead of re-serving the open delay on every tab.
    <TooltipProvider delay={500} closeDelay={0}>
      <div
        data-slot='editor-tabs'
        role='tablist'
        aria-label='Open files'
        className={cn(
          'flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-surface',
          className,
        )}>
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
              if (next) onActivate(next.path)
            }}
          />
        ))}
      </div>
    </TooltipProvider>
  )
}

function Tab({
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
}) {
  const dirty = isDirty(file)
  const ref = useRef<HTMLDivElement>(null)
  // Opening a file from the tree can push the new tab off the end of the strip;
  // the point of opening it was to look at it. `nearest` scrolls the minimum, so
  // a tab already on screen stays exactly where it is.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  const onAuxClick = (event: ReactMouseEvent) => {
    // Middle click. `auxclick` rather than `mousedown` so it matches how every
    // other middle-click target on the platform behaves.
    if (event.button !== 1) return
    event.preventDefault()
    onClose()
  }

  return (
    // The tab *is* the trigger (`render`), and it carries the full path — which
    // is why the viewer no longer spends a whole row on a line of monospace
    // nobody reads. No `title` alongside it: the browser's native tooltip would
    // show up underneath this one.
    <Tip
      side='bottom'
      render={
        <div
          ref={ref}
          role='tab'
          tabIndex={active ? 0 : -1}
          aria-selected={active}
          onClick={onActivate}
          onAuxClick={onAuxClick}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') onArrow(1)
            else if (event.key === 'ArrowLeft') onArrow(-1)
            else if (event.key === 'Enter' || event.key === ' ') onActivate()
            else return
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
        <span className='flex flex-col gap-0.5'>
          <span className='font-mono break-all'>{file.path}</span>
          {file.bytes !== undefined ? (
            <span className='text-fg-4'>{formatBytes(file.bytes)}</span>
          ) : null}
        </span>
      }>
      <span className={cn('max-w-40 truncate font-mono text-label', dirty && 'italic')}>
        {file.name}
      </span>
      {/* Errors are the one state the strip shows, because a failed tab
          otherwise looks identical to a loaded one until you focus it. */}
      {file.status === 'error' ? <span className='shrink-0 text-danger'>!</span> : null}
      <button
        type='button'
        aria-label={dirty ? `Close ${file.name} (unsaved changes)` : `Close ${file.name}`}
        onClick={(event) => {
          // Without this the click also activates the tab being closed, which
          // fights the reducer's focus-the-neighbour rule.
          event.stopPropagation()
          onClose()
        }}
        className={cn(
          'shrink-0 rounded p-0.5 text-fg-4 transition-opacity hover:bg-surface-hover hover:text-fg-1',
          // Always reachable by keyboard and on touch; only *shown* on hover for
          // the tab you are pointing at, as VS Code does.
          active || dirty
            ? 'opacity-70'
            : 'opacity-0 group-hover:opacity-70 focus-visible:opacity-100',
        )}>
        {/* VS Code's move: a dirty tab shows a dot where the ✕ goes, and the ✕
            comes back when you point at it — so unsaved work is visible at rest
            without taking away the way to close it. */}
        <span className={cn('block', dirty && 'group-hover:hidden')}>
          {dirty ? <span className='block size-3 rounded-full bg-fg-2' /> : <X className='size-3' />}
        </span>
        {dirty ? (
          <span className='hidden group-hover:block'>
            <X className='size-3' />
          </span>
        ) : null}
      </button>
    </Tip>
  )
}
