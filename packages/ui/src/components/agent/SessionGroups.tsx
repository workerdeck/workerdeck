import { useEffect, useRef, useState } from 'react'
import type { DragEvent, HTMLAttributes, ReactNode } from 'react'
import { ChevronDown, ChevronRight, GripVertical, Image as ImageIcon, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  addCustomGroup,
  moveCustomGroup,
  moveToCustomGroup,
  newCustomGroupId,
  removeCustomGroup,
  renameCustomGroup,
  sessionKey,
  styleCustomGroup,
  customGroupColor,
  groupSummary,
  PROJECT_ACCENTS,
} from '@workerdeck/protocol'
import type { CustomGroup, HostRelays, SessionGroup, SessionRow } from '@workerdeck/protocol'
import { dropZone, joinDrop, memberDrop, type DropZone, type TeamMove } from '../../lib/team-drop.ts'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover.tsx'
import { cn } from '../../lib/utils.ts'

type DragItem = { kind: 'session'; key: string } | { kind: 'group'; id: string }

export type GroupDrag = ReturnType<typeof useGroupDrag>

// Where a card sits: `lead` is set for a member, the team it is drawn under.
export type DragPlace = { row: SessionRow; lead?: SessionRow }

export type TeamDrag = {
  rowOf: (key: string) => SessionRow | undefined
  // A rejection's message is drawn under the card it was dropped on: a gateway 409 is user-facing copy.
  onMove: (move: TeamMove) => Promise<void> | void
  // Each gateway's relay identity by host id; without it a drop across gateways is refused.
  relays?: HostRelays
}

type Over = { spot: string; refusal?: string }

export type DropCue = { zone?: DropZone | 'refused'; message?: string }
type Landing = Over & { run?: () => void }

const ERROR_MS = 5000

// The payload lives in state rather than `dataTransfer`, which is unreadable during `dragover`; `setData` is still
// written because some engines refuse to start a drag without it. A card is split in three: the middle joins its
// team, the edges reorder (custom groups) or leave a team.
export function useGroupDrag(
  groups: readonly CustomGroup[],
  onChange: (groups: CustomGroup[]) => void,
  options: { custom: boolean; team?: TeamDrag },
) {
  const { custom, team } = options
  const [item, setItem] = useState<DragItem>()
  const [over, setOver] = useState<Over>()
  const [failure, setFailure] = useState<{ key: string; message: string }>()
  const failureTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(failureTimer.current), [])
  const end = () => {
    setItem(undefined)
    setOver(undefined)
  }
  const start = (e: DragEvent, next: DragItem) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', next.kind === 'session' ? next.key : next.id)
    setItem(next)
  }
  const accept = (e: DragEvent, next: Over) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = next.refusal ? 'none' : 'move'
    if (over?.spot !== next.spot || over.refusal !== next.refusal) {
      setOver(next)
    }
  }
  const fail = (key: string, err: unknown) => {
    clearTimeout(failureTimer.current)
    setFailure({ key, message: err instanceof Error ? err.message : String(err) })
    failureTimer.current = setTimeout(() => setFailure(undefined), ERROR_MS)
  }
  const move = (key: string, next: TeamMove) => () => {
    setFailure(undefined)
    void Promise.resolve()
      .then(() => team!.onMove(next))
      .catch((err: unknown) => fail(key, err))
  }

  function land(e: DragEvent<HTMLDivElement>, key: string, group: SessionGroup, place?: DragPlace): Landing | undefined {
    if (item?.kind !== 'session' || item.key === key) {
      return undefined
    }
    const reorder = custom
      ? { spot: `row:${key}`, run: () => onChange(moveToCustomGroup(groups, item.key, group.custom, group.custom ? key : undefined)) }
      : undefined
    const dragged = team?.rowOf(item.key)
    if (!team || !dragged || !place) {
      return reorder
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const zone = dropZone(e.clientY - rect.top, rect.height)
    if (place.lead) {
      const result = memberDrop(dragged, place.lead, place.row, zone, team.relays)
      return typeof result === 'string'
        ? { spot: `refused:${key}`, refusal: result }
        : { spot: `${zone === 'before' ? 'before' : 'after'}:${key}`, run: move(key, result) }
    }
    if (zone === 'join') {
      const result = joinDrop(dragged, place.row, team.relays)
      if (typeof result !== 'string') {
        return { spot: `join:${key}`, run: move(key, result) }
      }
      return reorder ?? { spot: `refused:${key}`, refusal: result }
    }
    if (dragged.info.agent?.lead !== undefined) {
      const leave = move(key, { row: dragged, lead: null })
      return {
        spot: `${zone}:${key}`,
        run: () => {
          leave()
          reorder?.run()
        },
      }
    }
    return reorder ? { ...reorder, spot: `${zone}:${key}` } : undefined
  }

  function session(key: string, group: SessionGroup, place?: DragPlace): HTMLAttributes<HTMLDivElement> {
    return {
      draggable: true,
      onDragStart: (e) => start(e, { kind: 'session', key }),
      onDragEnd: end,
      onDragOver: (e) => {
        const landing = land(e, key, group, place)
        if (landing) {
          accept(e, landing)
        }
      },
      onDrop: (e) => {
        const landing = land(e, key, group, place)
        if (!landing) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        landing.run?.()
        end()
      },
    }
  }

  function container(group: SessionGroup): HTMLAttributes<HTMLDivElement> {
    const leaving = () => {
      const dragged = item?.kind === 'session' ? team?.rowOf(item.key) : undefined
      return dragged?.info.agent?.lead !== undefined ? dragged : undefined
    }
    return {
      onDragOver: (e) => {
        if (item && (custom || leaving())) {
          accept(e, { spot: `group:${group.key}` })
        }
      },
      onDrop: (e) => {
        e.preventDefault()
        const member = leaving()
        if (member) {
          move(sessionKey(member), { row: member, lead: null })()
        }
        if (custom && item?.kind === 'session') {
          onChange(moveToCustomGroup(groups, item.key, group.custom))
        } else if (custom && item?.kind === 'group') {
          onChange(moveCustomGroup(groups, item.id, group.custom))
        }
        end()
      },
    }
  }

  function header(group: SessionGroup): HTMLAttributes<HTMLDivElement> {
    const id = group.custom
    if (id === undefined) {
      return {}
    }
    return { draggable: true, onDragStart: (e) => start(e, { kind: 'group', id }), onDragEnd: end }
  }

  // What to draw on a card while something hovers it, and a rejected drop's message for a while after.
  function cue(key: string): DropCue {
    if (failure?.key === key) {
      return { zone: 'refused', message: failure.message }
    }
    const spot = over?.spot
    if (!spot || spot.slice(spot.indexOf(':') + 1) !== key) {
      return {}
    }
    const kind = spot.slice(0, spot.indexOf(':'))
    if (kind === 'refused') {
      return { zone: 'refused', message: over?.refusal }
    }
    return kind === 'row' || kind === 'before'
      ? { zone: 'before' }
      : kind === 'after'
        ? { zone: 'after' }
        : kind === 'join'
          ? { zone: 'join' }
          : {}
  }

  return {
    dragging: item !== undefined,
    isOver: (spot: string) => over?.spot === spot,
    cue,
    session,
    container,
    header,
    create: (name = 'New group') => {
      const id = newCustomGroupId()
      onChange(addCustomGroup(groups, name, id))
      return id
    },
    rename: (id: string, name: string) => onChange(renameCustomGroup(groups, id, name)),
    style: (id: string, look: { color?: string | null; icon?: string | null }) => onChange(styleCustomGroup(groups, id, look)),
    remove: (id: string) => onChange(removeCustomGroup(groups, id)),
  }
}

export function CustomGroupHeader({
  group,
  look,
  editing,
  onEditingChange,
  onRename,
  onRemove,
  onStyle,
  dragProps,
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
  dragProps: HTMLAttributes<HTMLDivElement>
  collapsed?: boolean
  onToggleCollapsed?: () => void
}) {
  if (editing) {
    return <GroupNameInput initial={group.label ?? ''} onRename={onRename} onDone={() => onEditingChange(false)} />
  }

  const custom = group.custom !== undefined
  const summary = collapsed ? foldedSummary(group) : undefined
  return (
    <GroupHeading
      {...dragProps}
      label={group.label ?? ''}
      count={group.rows.length}
      after={
        summary ? <span className={cn('truncate', summary.attention ? 'text-warning' : 'text-fg-4/70')}>{summary.text}</span> : undefined
      }
      caps={!custom}
      className={cn('group/heading', custom && 'cursor-grab')}
      onDoubleClick={custom ? () => onEditingChange(true) : undefined}
      leading={
        <>
          {onToggleCollapsed ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              aria-label={collapsed ? `Expand ${group.label ?? 'group'}` : `Collapse ${group.label ?? 'group'}`}
              className="-mr-1 -ml-1 grid size-4 place-items-center rounded-sm text-fg-4 hover:text-fg-1"
              onClick={(e) => {
                e.stopPropagation()
                onToggleCollapsed()
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : null}
          {custom ? (
            <>
              <GripVertical className="-mr-1.5 -ml-1.5 size-3 opacity-0 group-hover/heading:opacity-60" />
              {look ? <GroupBadge group={look} onStyle={onStyle} /> : null}
            </>
          ) : null}
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

function foldedSummary(group: SessionGroup): { text: string; attention: number } | undefined {
  const summary = groupSummary(group)
  const parts = [
    summary.attention ? `${summary.attention} need${summary.attention === 1 ? 's' : ''} you` : undefined,
    summary.working ? `${summary.working} working` : undefined,
    summary.unseen ? `${summary.unseen} unread` : undefined,
  ].filter(Boolean)
  return parts.length ? { text: parts.join(' · '), attention: summary.attention } : undefined
}

export function GroupHeading({
  label,
  count,
  after,
  leading,
  actions,
  caps = true,
  className,
  ...rest
}: {
  label: ReactNode
  count: number
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
