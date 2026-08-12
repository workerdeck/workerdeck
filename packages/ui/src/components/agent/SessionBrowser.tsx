import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BellRing,
  CircleAlert,
  CircleSlash,
  Layers,
  Moon,
  PauseCircle,
  Pencil,
  Search,
  SearchX,
  Trash2,
  X,
} from 'lucide-react'
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
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { Input } from '../ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatRelativeTime, friendlyModel } from '../../lib/format.ts'

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
  /**
   * Whether the search + facet bar is shown. Defaults to `true` — a list that
   * *is* the screen shows its controls.
   *
   * A host with somewhere better to put the toggle (a view title bar) passes
   * `false` and owns the boolean itself, the way the VS Code extension does: the
   * key lives where the commands do. Two rules come with it, and they are why
   * this hides only the bar and nothing else — **closing the bar never clears
   * the filters**, and the subset line below it renders either way, so a list
   * filtered by a control you can't currently see still says so.
   */
  showControls?: boolean
  className?: string
}

/**
 * How a list row is drawn, in one place, so `SidebarRow` in `web` matches this
 * exactly rather than approximating it — the dashboard's other three sidebars
 * are that component, and a sessions list that hovered differently from the
 * gateways list beside it would read as a different product.
 *
 * Two rules are load-bearing:
 *
 * - **Fill means hover, and only hover.** It stays on the row whether or not
 *   the row is selected, because a selected row still has to answer the
 *   pointer. Selection gets the gutter instead.
 * - **`ml-0` on the selected row is not cosmetic.** It hands the accent border
 *   the 4px the margin was holding, so the text does not shift sideways as a
 *   row becomes the selected one. The squared left corners are what let the bar
 *   sit flush against the sidebar edge.
 */
export function rowShapeClass(active: boolean): string {
  return cn(
    'px-2 py-1.5 hover:bg-row-hover',
    active ? 'mr-1 ml-0 rounded-r-md border-l-4 border-l-accent' : 'mx-1 rounded-md',
  )
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
  showControls = true,
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
      {/* One control per row, label left, input right — the shape VS Code uses
          for its own filter surfaces. A wrapping row of pill-shaped selects
          reflows into an unpredictable number of lines as facets appear and
          disappear; a column of labelled rows is the same height every time and
          reads at sidebar width, which is the only width this has. */}
      <div className={cn('flex flex-col gap-1.5 px-2', !showControls && 'hidden')}>
        <div className='relative'>
          <Search className='pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4' />
          <Input
            value={config.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder='Search sessions'
            aria-label='Search sessions'
            className='pl-8'
          />
        </div>
        <FilterRow label='State'>
          <FacetSelect
            label='State'
            value={config.states}
            options={STATE_ORDER.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
            onChange={(states) => set({ states: states as SessionState[] })}
          />
        </FilterRow>
        {adapters.length > 1 ? (
          <FilterRow label='Engine'>
            <FacetSelect
              label='Engine'
              value={config.adapters}
              options={adapters.map((a) => ({ value: a, label: a }))}
              onChange={(adapters) => set({ adapters })}
            />
          </FilterRow>
        ) : null}
        {gateways.length > 1 ? (
          <FilterRow label='Gateway'>
            <FacetSelect
              label='Gateway'
              value={config.gateways}
              options={gateways.map((g) => ({ value: g.id, label: g.name }))}
              onChange={(gateways) => set({ gateways })}
            />
          </FilterRow>
        ) : null}
        <FilterRow label='Group'>
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
        </FilterRow>
        <FilterRow label='Sort'>
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
        </FilterRow>
      </div>

      {subset ? (
        <div className='flex items-center gap-2 px-3 text-label text-fg-4'>
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
        (emptyState ?? <Empty icon={<Layers />} title='No sessions yet' />)
      ) : visible.length === 0 ? (
        // Two different dead ends, two different ways out. "Nothing matches" is
        // a filter someone set; anything else is the state of the world — and
        // only the first has a button, because an action that does nothing is
        // worse than none.
        hasFacetFilter(config) ? (
          <Empty
            icon={<SearchX />}
            title='No matches'
            description='No session matches the current search and filters.'
            action='Clear filters'
            onAction={() => onConfigChange(clearFilters(config))}
          />
        ) : (
          <Empty icon={<Layers />} title='Nothing here' description='No session to show.' />
        )
      ) : (
        <div className='flex flex-col gap-4'>
          {groups.map((group) => (
            <div key={group.key} className='flex flex-col gap-1'>
              {config.groupBy !== 'none' && group.label ? (
                <div className='flex items-baseline gap-2 px-3 text-label font-medium text-fg-4'>
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
  const [editing, setEditing] = useState(false)

  // What it is and what it has spent, in one line — the same set the extension
  // shows, joined the same way, so the two lists read as one product.
  const folder = info.cwd.split('/').filter(Boolean).pop() ?? info.cwd
  const details = [
    showGateway ? row.hostName : undefined,
    friendlyModel(info.model),
    folder,
    info.profile ? `@${info.profile}` : undefined,
    formatCost(info.totalCostUsd),
  ].filter(Boolean)

  return (
    <div
      data-slot='session-row'
      data-active={active || undefined}
      // Selection lives on the whole row, not on the two text buttons inside
      // it: the age, the unread badge and the state glyph sit outside them, and
      // a row where a third of the surface silently does nothing is a row that
      // feels broken. The buttons stay — they are what makes the row reachable
      // by keyboard — but their activation now reaches this handler by
      // bubbling, so there is one code path and no double-fire. Anything that
      // is its own action (rename, close, the name editor) stops the event.
      onClick={() => !editing && onSelect?.(row)}
      className={cn(
        'group flex cursor-pointer flex-col gap-0.5 text-left transition-colors',
        rowShapeClass(active === true),
      )}>
      {/* Line one: what you scan the list by on the left, how it is doing on the
          right, state last. */}
      <div className='flex items-center gap-1.5'>
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
            className={cn(
              'min-w-0 flex-1 truncate text-left text-body-sm outline-none',
              active ? 'font-medium text-fg-1' : 'text-fg-2',
            )}>
            {sessionLabel(info)}
          </button>
        )}
        {row.unseen > 0 ? (
          // Transcript rows since this session was last on screen — the same
          // unit the VS Code badge counts, because turns undercount badly.
          <span
            title={`${row.unseen} new`}
            className='shrink-0 rounded-full bg-accent px-1.5 text-label text-accent-fg'>
            {row.unseen}
          </span>
        ) : null}
        <span className='shrink-0 text-label text-fg-4'>
          {formatRelativeTime(info.lastActivityAt ?? info.createdAt)}
        </span>
        <SessionStatusIcon row={row} />
      </div>

      {/* Line two: what it is, with the actions at the far right — away from the
          state icon, and away from the title you are actually reading. */}
      <div className='flex items-center gap-1 text-label text-fg-4'>
        <button
          type='button'
          tabIndex={-1}
          className='min-w-0 flex-1 truncate text-left font-mono outline-none'>
          {details.join(' · ')}
        </button>
        {onRename && !editing ? (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='Rename session'
            className='size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100'
            onClick={(e) => {
              e.stopPropagation()
              setEditing(true)
            }}>
            <Pencil className='size-3 text-fg-3' />
          </Button>
        ) : null}
        {onDelete ? (
          <Button
            variant='ghost'
            size='icon-sm'
            aria-label='Close session'
            className='size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100'
            onClick={(e) => {
              e.stopPropagation()
              onDelete(row)
            }}>
            <Trash2 className='size-3 text-fg-3' />
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/**
 * State as one glyph on the right edge — a ringing bell when it wants a human, a
 * spinner while it works, a moon when it is only sleeping. Replaces the text
 * badge: in a sidebar the word costs more room than it earns, and the states
 * that matter are the two you can recognise without reading.
 */
export function SessionStatusIcon({ row }: { row: SessionRow }) {
  const { info } = row
  if (info.pendingPermissionCount > 0 || info.status === 'awaiting_approval') {
    return <BellRing className='size-3.5 shrink-0 animate-pulse text-warning' />
  }
  if (info.status === 'running' || info.status === 'starting') {
    return <Spinner className='size-3.5 shrink-0 text-info' />
  }
  switch (info.status) {
    case 'failed':
      return <CircleAlert className='size-3.5 shrink-0 text-danger' />
    case 'closed':
      return <CircleSlash className='size-3.5 shrink-0 text-fg-4' />
    case 'parked':
      return <PauseCircle className='size-3.5 shrink-0 text-fg-3' />
    default:
      return <Moon className='size-3.5 shrink-0 text-fg-4' />
  }
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
/**
 * One labelled control row. The label column is fixed so every control starts
 * on the same x — the thing that makes a stack of them read as a form rather
 * than as five unrelated widgets.
 */
function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex items-center gap-2'>
      <span aria-hidden className='w-14 shrink-0 truncate text-label text-fg-3'>
        {label}
      </span>
      <div className='min-w-0 flex-1'>{children}</div>
    </div>
  )
}

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
        <SelectTrigger aria-label={label} className='min-w-0 flex-1'>
          <SelectValue>
            {/* "All" rather than the label, which the row already carries. */}
            {value.length === 0
              ? 'All'
              : value.length === 1
                ? (options.find((o) => o.value === value[0])?.label ?? 'All')
                : `${value.length} selected`}
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
      <SelectTrigger aria-label={label} className='w-full min-w-0'>
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
