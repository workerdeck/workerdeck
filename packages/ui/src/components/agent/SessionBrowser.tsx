import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Eraser, Layers, Pencil, Search, SearchX, Trash2, X } from 'lucide-react'
import {
  STATE_LABELS,
  STATE_ORDER,
  adaptersOf,
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  projectsOf,
  subsetSummary,
} from '@workerdeck/protocol'
import type { GroupBy, SessionRow, SessionState, SortBy, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { Input } from '../ui/Input.tsx'
import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from '../ui/Select.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionItem } from './SessionItem.tsx'
import { cn } from '../../lib/utils.ts'

// Re-exported only so the package's public surface does not shift under a host
// that imports it from here.
export { SessionStatusIcon } from './SessionStatusIcon.tsx'

/**
 * A sessions list with the affordances a list of thirty needs: search, facets,
 * grouping, sorting, unread counts, and one honest line about what is hidden.
 *
 * The *rules* are `@workerdeck/protocol`'s (`filterRows`/`groupRows`/
 * `subsetSummary`), never this component's — every client renders the same
 * model. `SessionList` remains beside this for the plain case.
 */

export interface SessionBrowserProps {
  rows: SessionRow[]
  config: ViewConfig
  onConfigChange: (config: ViewConfig) => void
  /** The host's own folders, if it has such a notion. Absent — a dashboard, a
   * phone — makes the scope filter genuinely inert rather than empty. */
  scope?: WorkspaceScope
  activeId?: string
  /**
   * Which sub-agent the host currently has open, by tool-use id — the *finer*
   * of the two selections. The card holding it drops to the secondary grey and
   * that step takes the blue; see `SessionItem`. A host with no sub-agent
   * surface leaves it undefined and nothing changes.
   */
  activeSubagentId?: string
  onSelect?: (row: SessionRow) => void
  onDelete?: (row: SessionRow) => void
  /**
   * Rename, from the row's pencil. Empty string restores the derived title. A
   * gateway edit (`PATCH /sessions/:id`), never a local override. A hover
   * affordance rather than double-click-the-title, because here a single click
   * on the row navigates.
   */
  onRename?: (row: SessionRow, title: string) => void
  /**
   * Clear the conversation in place. Same session, empty context — **not** a
   * delete: the engine keeps the old conversation and it stays resumable.
   * Rendered only where `capabilities.clearContext` allows it. A WS command,
   * not a REST route.
   */
  onClearContext?: (row: SessionRow) => void
  /** Open a session *at* one of its sub-agents, when the host can scroll a
   * transcript to a `Task` row. Absent, the sub-agent list still expands and a
   * step just opens its session — see `SessionRowItemProps`. */
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  /** Open a session and travel to one of its **tasks** — see
   * `SessionItem.onRevealStep`. A task has no agent behind it, so it is a place
   * to go rather than a thing to open. */
  onRevealStep?: (row: SessionRow, toolUseId: string) => void
  /** Rendered when nothing at all exists (as opposed to nothing matching). */
  emptyState?: React.ReactNode
  /**
   * Whether the search + facet bar is shown (default `true`). This hides only
   * the bar: **closing it never clears the filters**, and the subset line
   * renders either way, so a list filtered by a hidden control still says so.
   */
  showControls?: boolean
  /** Resolved project-icon bytes by content hash — `useProjectIcons`' output.
   * Passed in rather than fetched here, for `ProjectIcon`'s reason. Absent, or
   * a hash not in it yet, draws no picture. */
  projectIcons?: Record<string, string>
  className?: string
}

/**
 * How a list row is drawn, in one place, so `SidebarRow` in `web` matches this
 * exactly. Two rules are load-bearing:
 *
 * - **Fill means hover, and only hover** — it stays on a selected row too,
 *   because a selected row still has to answer the pointer. Selection gets the
 *   gutter instead.
 * - **`ml-0` on the selected row is not cosmetic**: it hands the accent border
 *   the 4px the margin was holding, so the text does not shift sideways.
 */
export const rowShapeClass = (active: boolean): string =>
  cn('px-2 py-1.5 hover:bg-row-hover', active ? 'mr-1 ml-0 rounded-r-md border-l-4 border-l-accent' : 'mx-1 rounded-md')

export function SessionBrowser({
  rows,
  config,
  onConfigChange,
  scope,
  activeId,
  activeSubagentId,
  onSelect,
  onDelete,
  onRename,
  onClearContext,
  onSelectSubagent,
  onRevealStep,
  emptyState,
  showControls = true,
  projectIcons,
  className,
}: SessionBrowserProps) {
  const visible = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(visible, config), [visible, config])
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  // Derived, not enumerated: a new engine or a new gateway needs no change here,
  // and a facet with one possible value is not a choice worth showing.
  const adapters = useMemo(() => adaptersOf(rows), [rows])
  const projects = useMemo(() => projectsOf(rows), [rows])
  const gateways = useMemo(() => {
    const seen = new Map<string, string>()
    for (const row of rows) {
      seen.set(row.hostId, row.hostName)
    }
    return [...seen].map(([id, name]) => ({ id, name }))
  }, [rows])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })

  return (
    <div data-slot="session-browser" className={cn('flex flex-col gap-3', className)}>
      {/* One control per row, label left, input right: a column of labelled
          rows is the same height every time, where a wrapping row of pills
          reflows as facets appear and disappear. */}
      <div className={cn('flex flex-col gap-1.5 px-2', !showControls && 'hidden')}>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
          <Input
            value={config.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="pl-8"
          />
        </div>
        <FilterRow label="State">
          <FacetSelect
            label="State"
            value={config.states}
            options={STATE_ORDER.map((s) => ({ value: s, label: STATE_LABELS[s] }))}
            onChange={(states) => set({ states: states as SessionState[] })}
          />
        </FilterRow>
        {adapters.length > 1 ? (
          <FilterRow label="Engine">
            <FacetSelect
              label="Engine"
              value={config.adapters}
              options={adapters.map((a) => ({ value: a, label: a }))}
              onChange={(adapters) => set({ adapters })}
            />
          </FilterRow>
        ) : null}
        {gateways.length > 1 ? (
          <FilterRow label="Gateway">
            <FacetSelect
              label="Gateway"
              value={config.gateways}
              options={gateways.map((g) => ({ value: g.id, label: g.name }))}
              onChange={(gateways) => set({ gateways })}
            />
          </FilterRow>
        ) : null}
        {projects.length > 1 ? (
          <FilterRow label="Project">
            <FacetSelect
              label="Project"
              value={config.projects ?? []}
              options={projects.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(next) => set({ projects: next })}
            />
          </FilterRow>
        ) : null}
        <FilterRow label="Group">
          <OneOfSelect
            label="Group"
            value={config.groupBy}
            options={[
              { value: 'none', label: 'No grouping' },
              { value: 'state', label: 'By state' },
              { value: 'adapter', label: 'By engine' },
              ...(projects.length > 1 ? [{ value: 'project' as const, label: 'By project' }] : []),
              ...(gateways.length > 1 ? [{ value: 'gateway' as const, label: 'By gateway' }] : []),
            ]}
            onChange={(groupBy) => set({ groupBy: groupBy as GroupBy })}
          />
        </FilterRow>
        <FilterRow label="Sort">
          <OneOfSelect
            label="Sort"
            value={config.sortBy}
            options={[
              { value: 'recent', label: 'Recent' },
              { value: 'name', label: 'Name' },
              { value: 'state', label: 'State' },
              ...(projects.length > 1 ? [{ value: 'project' as const, label: 'Project' }] : []),
              ...(gateways.length > 1 ? [{ value: 'gateway' as const, label: 'Gateway' }] : []),
            ]}
            onChange={(sortBy) => set({ sortBy: sortBy as SortBy })}
          />
        </FilterRow>
      </div>

      {subset ? (
        <div className="flex items-center gap-2 px-3 text-label text-fg-4">
          <span>
            {subset.shown} of {subset.total}
            {subset.causes.length ? ` · ${subset.causes.join(' · ')}` : null}
          </span>
          <button
            type="button"
            className="text-fg-3 underline underline-offset-2 hover:text-fg-1"
            onClick={() => onConfigChange(clearFilters(config))}
          >
            Show all
          </button>
        </div>
      ) : null}

      {rows.length === 0 ? (
        (emptyState ?? <Empty icon={<Layers />} title="No sessions yet" />)
      ) : visible.length === 0 ? (
        // Two dead ends, two ways out: only "nothing matches" has a button,
        // because it is the only one someone can act on.
        hasFacetFilter(config) ? (
          <Empty
            icon={<SearchX />}
            title="No matches"
            description="No session matches the current search and filters."
            action="Clear filters"
            onAction={() => onConfigChange(clearFilters(config))}
          />
        ) : (
          <Empty icon={<Layers />} title="Nothing here" description="No session to show." />
        )
      ) : (
        /* The 4px inset is **padding on the list**, never margins on the cards:
           `SessionItem` is `w-full`, and `w-full` plus `mx-1` is `100% + 8px` —
           an overflow by construction. */
        <div className="flex flex-col gap-4 px-1">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              {config.groupBy !== 'none' && group.label ? (
                <div className="flex items-center gap-2 px-2 text-label font-medium text-fg-4">
                  {/* Only the project facet has a mark of its own, and a group
                      IS one project root, so the first row is a fair source. */}
                  {config.groupBy === 'project' ? (
                    <ProjectIcon icon={group.rows[0]?.info.project?.icon} src={iconSrcOf(group.rows[0], projectIcons)} name={group.label} />
                  ) : null}
                  <span className="uppercase tracking-wide">{group.label}</span>
                  <span className="text-fg-4/70">{group.rows.length}</span>
                </div>
              ) : null}
              {group.rows.map((row) => (
                <SessionRowItem
                  key={`${row.hostId}:${row.info.id}`}
                  row={row}
                  active={row.info.id === activeId}
                  activeSubagentId={activeSubagentId}
                  showGateway={gateways.length > 1 && config.groupBy !== 'gateway'}
                  showProject={config.groupBy !== 'project'}
                  projectIcons={projectIcons}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  onClearContext={onClearContext}
                  onSelectSubagent={onSelectSubagent}
                  onRevealStep={onRevealStep}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The bytes for a row's project icon. Shared by the row and its group header
 * so the two cannot draw different pictures for one project. */
const iconSrcOf = (row: SessionRow | undefined, icons: Record<string, string> | undefined): string | undefined => {
  const icon = row?.info.project?.icon
  return icon?.type === 'image' ? icons?.[icon.hash] : undefined
}

interface SessionRowItemProps {
  row: SessionRow
  active?: boolean
  /** See `SessionBrowserProps.activeSubagentId`. */
  activeSubagentId?: string
  showGateway?: boolean
  /** False when the list is already grouped by project — the slot then goes to
   * the *sub-path inside the project* (`projectSubpath`). See
   * `SessionItemProps.showProject`. */
  showProject?: boolean
  projectIcons?: Record<string, string>
  onSelect?: (row: SessionRow) => void
  onDelete?: (row: SessionRow) => void
  onRename?: (row: SessionRow, title: string) => void
  /** See `SessionBrowserProps.onClearContext` — gated on the row's own
   * capability record, not on the engine name. */
  onClearContext?: (row: SessionRow) => void
  /** Open one of a session's sub-agents — handing the panel over to that
   * agent's own work (`SessionPanel.openSubagent`). Without it a step just
   * opens the session. Only *agent* steps ever call it — see `Step.kind`. */
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  /** See `SessionBrowserProps.onRevealStep`. */
  onRevealStep?: (row: SessionRow, toolUseId: string) => void
}

const SessionRowItem = ({
  row,
  active,
  activeSubagentId,
  showGateway,
  showProject = true,
  projectIcons,
  onSelect,
  onDelete,
  onRename,
  onClearContext,
  onSelectSubagent,
  onRevealStep,
}: SessionRowItemProps) => {
  const { info } = row
  // A pencil rather than the card's own double-click: the dashboard already
  // spends the row's hover on two other actions. The trigger is `external` and
  // this owns the flag.
  const [editing, setEditing] = useState(false)

  return (
    <SessionItem
      row={row}
      active={active === true}
      activeStepKey={activeSubagentId}
      showGateway={showGateway}
      showProject={showProject}
      projectIcons={projectIcons}
      onSelect={() => onSelect?.(row)}
      onSelectSubagent={onSelectSubagent ? (id) => onSelectSubagent(row, id) : undefined}
      onRevealStep={onRevealStep ? (id) => onRevealStep(row, id) : undefined}
      onRename={onRename ? (title) => onRename(row, title) : undefined}
      renameOn="external"
      editing={editing}
      onEditingChange={setEditing}
      actions={
        <>
          {onRename && !editing ? (
            <RowAction label="Rename session" onClick={() => setEditing(true)}>
              <Pencil className="size-3 text-fg-3" />
            </RowAction>
          ) : null}
          {/* Gated on the row's own capability record, never on the engine name. */}
          {onClearContext && info.capabilities?.clearContext ? (
            <RowAction
              label="Clear context"
              title="Clear the conversation — the session keeps running and the old conversation stays resumable"
              onClick={() => onClearContext(row)}
            >
              <Eraser className="size-3 text-fg-3" />
            </RowAction>
          ) : null}
          {onDelete ? (
            <RowAction label="Close session" onClick={() => onDelete(row)}>
              <Trash2 className="size-3 text-fg-3" />
            </RowAction>
          ) : null}
        </>
      }
    />
  )
}

/** One of the dashboard's hover actions. Stops the click — the whole card is
 * pressable underneath, and an action that also selected the session would do
 * two things per press. */
const RowAction = ({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: ReactNode }) => {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={title ?? label}
      className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </Button>
  )
}

/** One labelled control row. The label column is fixed so every control starts
 * on the same x. */
const FilterRow = ({ label, children }: { label: string; children: React.ReactNode }) => {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className="w-14 shrink-0 truncate text-label text-fg-3">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/** A multi-select facet. Empty = no filter, which is why the trigger reads
 * "All" rather than excluding anything. */
const FacetSelect = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string[]
  options: { value: string; label: string }[]
  onChange: (value: string[]) => void
}) => {
  return (
    <div className="flex items-center gap-1">
      <Select multiple value={value} onValueChange={(v) => onChange(v as string[])}>
        <SelectTrigger aria-label={label} className="min-w-0 flex-1">
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
        <Button variant="ghost" size="icon-sm" aria-label={`Clear ${label}`} onClick={() => onChange([])}>
          <X className="size-3 text-fg-4" />
        </Button>
      ) : null}
    </div>
  )
}

const OneOfSelect = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) => {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as string)}>
      <SelectTrigger aria-label={label} className="w-full min-w-0">
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
