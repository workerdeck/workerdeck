import { useState } from 'react'
import type { DragEvent, HTMLAttributes, ReactNode } from 'react'
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  addCustomGroup,
  moveCustomGroup,
  moveToCustomGroup,
  newCustomGroupId,
  removeCustomGroup,
  renameCustomGroup,
} from '@workerdeck/protocol'
import type { CustomGroup, SessionGroup } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { cn } from '../../lib/utils.ts'

type DragItem = { kind: 'session'; key: string } | { kind: 'group'; id: string }

export type GroupDrag = ReturnType<typeof useGroupDrag>

// The payload lives in state rather than `dataTransfer`, which is unreadable during `dragover`; `setData` is still
// written because some engines refuse to start a drag without it.
export function useGroupDrag(groups: readonly CustomGroup[], onChange: (groups: CustomGroup[]) => void) {
  const [item, setItem] = useState<DragItem>()
  const [over, setOver] = useState<string>()
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
  const accept = (e: DragEvent, spot: string) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setOver(spot)
  }

  function session(key: string, group: SessionGroup): HTMLAttributes<HTMLDivElement> {
    return {
      draggable: true,
      onDragStart: (e) => start(e, { kind: 'session', key }),
      onDragEnd: end,
      onDragOver: (e) => {
        if (item?.kind === 'session') {
          accept(e, `row:${key}`)
        }
      },
      onDrop: (e) => {
        if (item?.kind !== 'session') {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        if (item.key !== key) {
          onChange(moveToCustomGroup(groups, item.key, group.custom, group.custom ? key : undefined))
        }
        end()
      },
    }
  }

  function container(group: SessionGroup): HTMLAttributes<HTMLDivElement> {
    return {
      onDragOver: (e) => {
        if (item) {
          accept(e, `group:${group.key}`)
        }
      },
      onDrop: (e) => {
        e.preventDefault()
        if (item?.kind === 'session') {
          onChange(moveToCustomGroup(groups, item.key, group.custom))
        } else if (item?.kind === 'group') {
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

  return {
    dragging: item !== undefined,
    isOver: (spot: string) => over === spot,
    session,
    container,
    header,
    create: (name = 'New group') => {
      const id = newCustomGroupId()
      onChange(addCustomGroup(groups, name, id))
      return id
    },
    rename: (id: string, name: string) => onChange(renameCustomGroup(groups, id, name)),
    remove: (id: string) => onChange(removeCustomGroup(groups, id)),
  }
}

export function CustomGroupHeader({
  group,
  editing,
  onEditingChange,
  onRename,
  onRemove,
  dragProps,
}: {
  group: SessionGroup
  editing: boolean
  onEditingChange: (editing: boolean) => void
  onRename: (name: string) => void
  onRemove: () => void
  dragProps: HTMLAttributes<HTMLDivElement>
}) {
  if (editing) {
    return <GroupNameInput initial={group.label ?? ''} onRename={onRename} onDone={() => onEditingChange(false)} />
  }

  const custom = group.custom !== undefined
  return (
    <GroupHeading
      {...dragProps}
      label={group.label ?? ''}
      count={group.rows.length}
      className={cn('group/heading', custom && 'cursor-grab')}
      onDoubleClick={custom ? () => onEditingChange(true) : undefined}
      leading={custom ? <GripVertical className="-ml-1.5 size-3 opacity-0 group-hover/heading:opacity-60" /> : undefined}
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

export function GroupHeading({
  label,
  count,
  leading,
  actions,
  className,
  ...rest
}: {
  label: string
  count: number
  leading?: ReactNode
  actions?: ReactNode
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cn('group/heading flex min-h-5 items-center gap-2 px-2 text-label font-medium text-fg-4', className)}>
      {leading}
      <span className="min-w-0 truncate uppercase tracking-wide">{label}</span>
      <span className="text-fg-4/70">{count}</span>
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
