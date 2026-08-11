import { useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, Search, Trash2, X } from 'lucide-react'
import {
  STATE_LABELS,
  STATE_ORDER,
  adaptersOf,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  sessionLabel,
  subsetSummary,
} from '@workerdeck/protocol'
import type {
  GroupBy,
  SessionRow,
  SessionState,
  SortBy,
  ViewConfig,
  WorkspaceScope,
} from '@workerdeck/protocol'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Input } from '../ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatRelativeTime } from '../../lib/format.ts'
import { STATUS_META } from './status.ts'

/**
 * A sessions list with the affordances a list of thirty needs: search, facets,
 * grouping, sorting, unread counts, and one honest line about what is hidden.
 *
 * The *rules* are `@workerdeck/protocol`'s (`filterRows`/`groupRows`/
 * `subsetSummary`), not this component's — the VS Code sidebar renders the same
 * model with workbench chrome, its activity-bar badge counts the same rows this
 * would show, and iOS mirrors them in Swift. What lives here is the styled
 * rendering of that model, so a host that wants the dashboard's look gets it
 * without reimplementing the model behind it.
 *
 * `SessionList` remains beside this for the plain case (a fixed set of rows, no
 * controls); this is what you reach for when the list is the screen.
 */

export interface SessionBrowserProps {
  rows: SessionRow[]
  config: ViewConfig
  onConfigChange: (config: ViewConfig) => void
  /** The host's own folders, if it has such a notion. Absent — a dashboard, a
   * phone — makes the scope filter genuinely inert rather than empty. */
  scope?: WorkspaceScope
  activeId?: string
  onSelect?: (row: SessionRow) => void
  onDelete?: (row: SessionRow) => void
  /**
   * Rename, from the row's pencil. Empty string restores the derived title. A
   * gateway edit (`PATCH /sessions/:id`), never a local override — every client
   * should see the same name. Omit to make titles read-only.
   *
   * A hover affordance rather than the extension's double-click-the-title,
   * because here a single click on the row navigates: the *first* click of a
   * double-click would have already left the page.
   */
  onRename?: (row: SessionRow, title: string) => void
  /** Rendered when nothing at all exists (as opposed to nothing matching). */
  emptyState?: React.ReactNode
  className?: string
}

export function SessionBrowser({
  rows,
  config,
  onConfigChange,
  scope,
  activeId,
  onSelect,
  onDelete,
  onRename,
  emptyState,
  className,
}: SessionBrowserProps) {
  const visible = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(visible, config), [visible, config])
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  // Derived, not enumerated: a new engine or a new gateway needs no change here,
  // and a facet with one possible value is not a choice worth showing.
  const adapters = useMemo(() => adaptersOf(rows), [rows])
  const gateways = useMemo(() => {
    const seen = new Map<string, string>()
    for (const row of rows) seen.set(row.hostId, row.hostName)
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [rows])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })

  return (
    <div data-slot='session-browser' className={cn('flex flex-col gap-3', className)}>
      <div className='flex flex-wrap items-center gap-2'>
        <div className='relative min-w-48 flex-1'>
          <Search className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4' />
          <Input
            value={config.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder='Search sessions'
            aria-label='Search sessions'
            className='pl-8'
          />
        </div>
        <FacetSelect
          label='State'
          value={config.states}
          options={STATE_ORDER.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
          onChange={(states) => set({ states: states as SessionState[] })}
        />
        {adapters.length > 1 ? (
          <FacetSelect
            label='Engine'
            value={config.adapters}
            options={adapters.map((a) => ({ value: a, label: a }))}
            onChange={(adapters) => set({ adapters })}
          />
        ) : null}
        {gateways.length > 1 ? (
          <FacetSelect
            label='Gateway'
            value={config.gateways}
            options={gateways.map((g) => ({ value: g.id, label: g.name }))}
            onChange={(gateways) => set({ gateways })}
          />
        ) : null}
        <OneOfSelect
          label='Group'
          value={config.groupBy}
          options={[
            { value: 'none', label: 'No grouping' },
            { value: 'state', label: 'By state' },
            { value: 'adapter', label: 'By engine' },
            ...(gateways.length > 1 ? [{ value: 'gateway' as const, label: 'By gateway' }] : []),
          ]}
          onChange={(groupBy) => set({ groupBy: groupBy as GroupBy })}
        />
        <OneOfSelect
          label='Sort'
          value={config.sortBy}
          options={[
            { value: 'recent', label: 'Recent' },
            { value: 'name', label: 'Name' },
            { value: 'state', label: 'State' },
            ...(gateways.length > 1 ? [{ value: 'gateway' as const, label: 'Gateway' }] : []),
          ]}
          onChange={(sortBy) => set({ sortBy: sortBy as SortBy })}
        />
      </div>

      {subset ? (
        <div className='flex items-center gap-2 text-label text-fg-4'>
          <span>
            {subset.shown} of {subset.total}
            {subset.causes.length ? ` · ${subset.causes.join(' · ')}` : null}
          </span>
          <button
            type='button'
            className='text-fg-3 underline underline-offset-2 hover:text-fg-1'
            onClick={() => onConfigChange(clearFilters(config))}>
            Show all
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        (emptyState ?? <Empty>No sessions yet.</Empty>)
      ) : visible.length === 0 ? (
        // Two different dead ends, two different ways out. "Nothing matches" is
        // a filter someone set; anything else is the state of the world.
        <Empty>
          {hasFacetFilter(config) ? (
            <>
              No sessions match.{' '}
              <button
                type='button'
                className='underline underline-offset-2 hover:text-fg-1'
                onClick={() => onConfigChange(clearFilters(config))}>
                Clear filters
              </button>
            </>
          ) : (
            'No sessions here.'
          )}
        </Empty>
      ) : (
        <div className='flex flex-col gap-4'>
          {groups.map((group) => (
            <div key={group.key} className='flex flex-col gap-1'>
              {config.groupBy !== 'none' && group.label ? (
                <div className='flex items-baseline gap-2 px-2.5 text-label font-medium text-fg-4'>
                  <span className='uppercase tracking-wide'>{group.label}</span>
                  <span className='text-fg-4/70'>{group.rows.length}</span>
                </div>
              ) : null}
              {group.rows.map((row) => (
                <SessionRowItem
                  key={`${row.hostId}:${row.info.id}`}
                  row={row}
                  active={row.info.id === activeId}
                  showGateway={gateways.length > 1}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className='px-2.5 py-6 text-center text-body-sm text-fg-4'>{children}</div>
}

interface SessionRowItemProps {
  row: SessionRow
  active?: boolean
  showGateway?: boolean
  onSelect?: (row: SessionRow) => void
  onDelete?: (row: SessionRow) => void
  onRename?: (row: SessionRow, title: string) => void
}

function SessionRowItem({
  row,
  active,
  showGateway,
  onSelect,
  onDelete,
  onRename,
}: SessionRowItemProps) {
  const { info } = row
  const meta = STATUS_META[info.status]
  const [editing, setEditing] = useState(false)

  return (
    <div
      data-slot='session-row'
      data-active={active || undefined}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors',
        active ? 'border-border bg-surface' : 'hover:bg-surface-hover',
      )}>
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-2'>
          {/* The editor replaces the link rather than sitting inside it — an
              input nested in a button is invalid, and disabling the button to
              protect the edit disables the field with it. */}
          {editing && onRename ? (
            <NameEditor
              initial={info.title ?? ''}
              onCommit={(title) => {
                setEditing(false)
                onRename(row, title)
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <button
              type='button'
              onClick={() => onSelect?.(row)}
              className='min-w-0 truncate text-left text-body-sm font-medium text-fg-1 outline-none'>
              {sessionLabel(info)}
            </button>
          )}
          <Badge variant={meta.variant} dot className='shrink-0'>
            {meta.label}
          </Badge>
          {row.unseen > 0 ? (
            // Transcript rows since this session was last on screen — the same
            // unit the VS Code badge counts, because turns undercount badly.
            <Badge variant='accent' className='shrink-0' title={`${row.unseen} new`}>
              {row.unseen}
            </Badge>
          ) : null}
        </div>
        <button
          type='button'
          onClick={() => !editing && onSelect?.(row)}
          className='mt-0.5 flex w-full items-center gap-2 text-left font-mono text-label text-fg-4 outline-none'>
          <span className='truncate'>{info.cwd}</span>
          {showGateway ? <span className='shrink-0'>{row.hostName}</span> : null}
          {info.profile ? <span className='shrink-0'>@{info.profile}</span> : null}
          <span className='shrink-0'>{formatCost(info.totalCostUsd)}</span>
          <span className='shrink-0'>
            {formatRelativeTime(info.lastActivityAt ?? info.createdAt)}
          </span>
        </button>
      </div>
      {onRename && !editing ? (
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label='Rename session'
          className='opacity-0 transition-opacity group-hover:opacity-100'
          onClick={() => setEditing(true)}>
          <Pencil className='size-3.5 text-fg-3' />
        </Button>
      ) : null}
      {onDelete ? (
        <Button
          variant='ghost'
          size='icon-sm'
          aria-label='Close session'
          className='opacity-0 transition-opacity group-hover:opacity-100'
          onClick={() => onDelete(row)}>
          <Trash2 className='size-3.5 text-fg-3' />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * Inline rename. Enter commits, Escape cancels, blur commits — but only a blur
 * that is still inside this document: switching windows must not silently commit,
 * nor kill the editor in the frame it opened.
 */
function NameEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.select()
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      autoFocus
      aria-label='Session name'
      // The row is a button; a click in here must not select the session.
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => (document.hasFocus() ? onCommit(value.trim()) : undefined)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value.trim())
        else if (e.key === 'Escape') onCancel()
        e.stopPropagation()
      }}
      className='-my-0.5 min-w-0 flex-1 rounded-sm border border-ring bg-bg px-1 py-0.5 text-body-sm font-medium text-fg-1 outline-none'
    />
  )
}

/** A multi-select facet. Empty = no filter, which is why the trigger reads the
 * facet's name rather than "All": nothing is being excluded. */
function FacetSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string[]
  options: { value: string; label: string }[]
  onChange: (value: string[]) => void
}) {
  return (
    <div className='flex items-center gap-1'>
      <Select multiple value={value} onValueChange={(v) => onChange(v as string[])}>
        <SelectTrigger aria-label={label} className='min-w-28'>
          <SelectValue>
            {value.length === 0
              ? label
              : value.length === 1
                ? (options.find((o) => o.value === value[0])?.label ?? label)
                : `${label} · ${value.length}`}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              <SelectItemText>{option.label}</SelectItemText>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {value.length > 0 ? (
        <Button variant='ghost' size='icon-sm' aria-label={`Clear ${label}`} onClick={() => onChange([])}>
          <X className='size-3 text-fg-4' />
        </Button>
      ) : null}
    </div>
  )
}

function OneOfSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as string)}>
      <SelectTrigger aria-label={label} className='min-w-28'>
        <SelectValue>{options.find((o) => o.value === value)?.label ?? label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            <SelectItemText>{option.label}</SelectItemText>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
