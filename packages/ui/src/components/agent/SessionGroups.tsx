import { useRef, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { ChevronDown, ChevronRight, Image as ImageIcon, Pencil, Plus, Trash2 } from 'lucide-react'
import { customGroupColor, groupFoldSummary, PROJECT_ACCENTS } from '@workerdeck/protocol'
import type { CustomGroup, SessionGroup } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover.tsx'
import { cn } from '../../lib/utils.ts'

export function CustomGroupHeader({
  group,
  look,
  editing,
  onEditingChange,
  onRename,
  onRemove,
  onStyle,
  dragProps,
  draggable = false,
  collapsed = false,
  onToggleCollapsed,
}: {
  group: SessionGroup
  // The stored group, for its colour and image; absent for the ungrouped bucket.
  look?: CustomGroup
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onRename: (name: string) => void
  onRemove: () => void
  onStyle?: (look: { color?: string | null; icon?: string | null }) => void
  dragProps: HTMLAttributes<HTMLElement>
  draggable?: boolean
  collapsed?: boolean
  onToggleCollapsed?: () => void
}) {
  if (editing) {
    return <GroupNameInput initial={group.label ?? ''} onRename={onRename} onDone={() => onEditingChange(false)} />
  }

  const custom = group.custom !== undefined
  const summary = collapsed ? groupFoldSummary(group) : undefined
  return (
    <GroupHeading
      {...dragProps}
      label={group.label ?? ''}
      count={group.rows.length}
      after={
        summary ? <span className={cn('truncate', summary.attention ? 'text-warning' : 'text-fg-4/70')}>{summary.text}</span> : undefined
      }
      caps={!custom}
      className={cn('group/heading', draggable && 'cursor-grab')}
      onDoubleClick={custom ? () => onEditingChange(true) : undefined}
      leading={
        <>
          {onToggleCollapsed ? <FoldButton name={group.label ?? 'group'} collapsed={collapsed} onToggle={onToggleCollapsed} /> : null}
          {custom ? <>{look ? <GroupBadge group={look} onStyle={onStyle} /> : null}</> : null}
        </>
      }
      actions={
        custom ? (
          <>
            <HeadingAction label="Rename group" onClick={() => onEditingChange(true)}>
              <Pencil className="size-3" />
            </HeadingAction>
            <HeadingAction label="Delete group" title="Delete the group - its sessions move to Ungrouped" onClick={onRemove}>
              <Trash2 className="size-3" />
            </HeadingAction>
          </>
        ) : undefined
      }
    />
  )
}

function FoldButton({ name, collapsed, onToggle }: { name: string; collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
      className="-mr-1 -ml-1 grid size-4 place-items-center rounded-sm text-fg-4 hover:text-fg-1"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
    </button>
  )
}

// A state, engine or project heading: folds, drags to reorder, and names a project's gateway as a badge after it.
export function FacetGroupHeader({
  group,
  label,
  caps,
  icon,
  badge,
  title,
  actions,
  dragProps,
  draggable,
  collapsed,
  onToggleCollapsed,
}: {
  group: SessionGroup
  label: string
  caps: boolean
  icon?: ReactNode
  badge?: string
  title?: string
  actions?: ReactNode
  dragProps: HTMLAttributes<HTMLElement>
  draggable: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
}) {
  const summary = collapsed ? groupFoldSummary(group) : undefined
  return (
    <GroupHeading
      {...dragProps}
      label={label}
      count={group.rows.length}
      title={title}
      caps={caps}
      className={cn(draggable && 'cursor-grab')}
      leading={
        <>
          <FoldButton name={label} collapsed={collapsed} onToggle={onToggleCollapsed} />
          {icon}
        </>
      }
      badge={badge}
      after={
        summary ? <span className={cn('truncate', summary.attention ? 'text-warning' : 'text-fg-4/70')}>{summary.text}</span> : undefined
      }
      actions={actions}
    />
  )
}

function GroupNameInput({ initial, onRename, onDone }: { initial: string; onRename: (name: string) => void; onDone: () => void }) {
  const [draft, setDraft] = useState(initial)
  const commit = () => {
    const name = draft.trim()
    if (name && name !== initial) {
      onRename(name)
    }
    onDone()
  }
  return (
    <div className="px-2">
      <Input
        autoFocus
        aria-label="Group name"
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            onDone()
          }
        }}
        className="h-6 text-label"
      />
    </div>
  )
}

export function GroupHeading({
  label,
  count,
  badge,
  after,
  leading,
  actions,
  caps = true,
  className,
  ...rest
}: {
  label: ReactNode
  count: number
  badge?: string
  after?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  // Off for a name the operator typed, which keeps its own case.
  caps?: boolean
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('group/heading flex min-h-5 items-center gap-2 px-2 text-label font-medium text-fg-4', className)}>
      {leading}
      <span className={cn('min-w-0 truncate', caps ? 'uppercase tracking-wide' : 'text-fg-3')}>{label}</span>
      {badge ? <span className="shrink-0 rounded-sm border border-border px-1 leading-4 font-normal text-fg-4">{badge}</span> : null}
      <span className="text-fg-4/70">{count}</span>
      {after}
      {actions ? (
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/heading:opacity-100 focus-within:opacity-100">
          {actions}
        </span>
      ) : null}
    </div>
  )
}

export function HeadingAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={title ?? label}
      className="size-5 text-fg-3"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </Button>
  )
}

export function NewGroupButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="xs" className="mx-1 self-start text-fg-3" onClick={onClick}>
      <Plus />
      New group
    </Button>
  )
}

const ICON_PX = 64

// A group's badge: its image, else its colour; pressing it picks either.
export function GroupBadge({
  group,
  onStyle,
}: {
  group: CustomGroup
  onStyle?: (look: { color?: string | null; icon?: string | null }) => void
}) {
  const [error, setError] = useState<string>()
  const file = useRef<HTMLInputElement>(null)
  const mark = group.icon ? (
    <img src={group.icon} alt="" className="size-3.5 rounded-[3px] object-cover" draggable={false} />
  ) : (
    <span className="size-2 rounded-[2px]" style={{ background: customGroupColor(group) }} />
  )
  if (!onStyle) {
    return <span className="flex size-3.5 shrink-0 items-center justify-center">{mark}</span>
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Colour or image for ${group.name}`}
            title="Colour or image"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] hover:ring-1 hover:ring-border"
          >
            {mark}
          </button>
        }
      />
      <PopoverContent align="start" className="flex w-44 flex-col gap-2">
        <div className="grid grid-cols-4 gap-1.5">
          {PROJECT_ACCENTS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Colour ${color}`}
              onClick={() => onStyle({ color, icon: null })}
              className={cn(
                'h-6 rounded-[4px] ring-offset-1 ring-offset-surface',
                !group.icon && customGroupColor(group) === color && 'ring-2 ring-fg-3',
              )}
              style={{ background: color }}
            />
          ))}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0]
            e.target.value = ''
            if (!picked) {
              return
            }
            setError(undefined)
            void iconFromFile(picked)
              .then((icon) => onStyle({ icon }))
              .catch(() => setError('That image could not be read'))
          }}
        />
        <Button variant="outline" size="xs" onClick={() => file.current?.click()}>
          <ImageIcon />
          Choose image…
        </Button>
        {group.icon ? (
          <Button variant="ghost" size="xs" onClick={() => onStyle({ icon: null })}>
            Remove image
          </Button>
        ) : null}
        {error ? <span className="text-label text-danger">{error}</span> : null}
      </PopoverContent>
    </Popover>
  )
}

// Scaled to cover a 64 px square and re-encoded, so a photo from disk stores as a few kB in the view config.
async function iconFromFile(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = ICON_PX
  canvas.height = ICON_PX
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('no canvas')
  }
  const scale = Math.max(ICON_PX / bitmap.width, ICON_PX / bitmap.height)
  const width = bitmap.width * scale
  const height = bitmap.height * scale
  context.drawImage(bitmap, (ICON_PX - width) / 2, (ICON_PX - height) / 2, width, height)
  bitmap.close()
  return canvas.toDataURL('image/png')
}
