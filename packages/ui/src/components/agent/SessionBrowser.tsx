import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Eraser, FolderOpen, Layers, Pencil, Search, SearchX, Trash2, X } from 'lucide-react'
import { clearFilters, filterRows, groupRows, hasFacetFilter, scopeActive, subsetSummary } from '@workerdeck/protocol'
import type { SessionRow, SessionTask, StepDisplay, SubagentDisplay, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { Input } from '../ui/Input.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionFilters } from './SessionFilters.tsx'
import { SessionItem, type SelectModifiers } from './SessionItem.tsx'
import { cn } from '../../lib/utils.ts'

export { SessionStatusIcon } from './SessionStatusIcon.tsx'

export interface SessionBrowserProps {
  rows: SessionRow[]
  config: ViewConfig
  onConfigChange: (config: ViewConfig) => void
  scope?: WorkspaceScope
  activeId?: string
  activeSubagentId?: string
  activeShellId?: string
  now?: number
  // Overrides `activeId`, for a host whose session ids are unique only per gateway.
  isActive?: (row: SessionRow) => boolean
  // Replaces the pencil / eraser / trash; rename then falls back to the card's own double-click.
  rowActions?: (row: SessionRow) => ReactNode
  // Overrides the count of gateways among `rows` when deciding whether a card names its gateway.
  gatewayCount?: number
  showSubset?: boolean
  onSelect?: (row: SessionRow, modifiers: SelectModifiers) => void
  onDelete?: (row: SessionRow) => void
  onRename?: (row: SessionRow, title: string) => void
  onClearContext?: (row: SessionRow) => void
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  onSelectTask?: (row: SessionRow, task: SessionTask) => void
  onStopTask?: (row: SessionRow, toolUseId: string) => void
  onSelectShell?: (row: SessionRow, shellId: string) => void
  onKillShell?: (row: SessionRow, shellId: string) => void
  onShellAgentWrite?: (row: SessionRow, shellId: string, enabled: boolean) => void
  emptyState?: ReactNode
  // The facet controls, drawn inline. A host with a header puts `SessionFiltersButton` there instead.
  showControls?: boolean
  showSearch?: boolean
  autoFocusSearch?: boolean
  projectIcons?: Record<string, string>
  className?: string
}

export function rowShapeClass(active: boolean): string {
  return cn('px-2 py-1.5 hover:bg-row-hover', active ? 'mr-1 ml-0 rounded-r-md border-l-4 border-l-accent' : 'mx-1 rounded-md')
}

export function SessionBrowser({
  rows,
  config,
  onConfigChange,
  scope,
  activeId,
  activeSubagentId,
  activeShellId,
  now,
  isActive = (row) => row.info.id === activeId,
  rowActions,
  gatewayCount,
  showSubset = true,
  onSelect,
  onDelete,
  onRename,
  onClearContext,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
  emptyState,
  showControls = true,
  showSearch = showControls,
  autoFocusSearch,
  projectIcons,
  className,
}: SessionBrowserProps) {
  const visible = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(visible, config), [visible, config])
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  const rowGateways = useMemo(() => new Set(rows.map((row) => row.hostId)).size, [rows])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })

  return (
    <div data-slot="session-browser" className={cn('flex flex-col gap-3', className)}>
      {showSearch ? (
        <SessionSearch value={config.search} onChange={(search) => set({ search })} autoFocus={autoFocusSearch} className="px-2" />
      ) : null}
      {showControls ? <SessionFilters config={config} onConfigChange={onConfigChange} rows={rows} scope={scope} className="px-2" /> : null}

      {subset && showSubset ? (
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
        hasFacetFilter(config) ? (
          <Empty
            icon={<SearchX />}
            title="No matches"
            description="No session matches the current search and filters."
            action="Clear filters"
            onAction={() => onConfigChange(clearFilters(config))}
          />
        ) : scope && scopeActive(config, scope) ? (
          <Empty
            icon={<FolderOpen />}
            title="Nothing in this folder"
            description={`No session is running in ${scope.label}.`}
            action="Show all folders"
            onAction={() => set({ scoped: false })}
          />
        ) : (
          <Empty icon={<Layers />} title="Nothing here" description="No session to show." />
        )
      ) : (
        <div className="flex flex-col gap-4 px-1">
          {groups.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              {config.groupBy !== 'none' && group.label ? (
                <div className="flex items-center gap-2 px-2 text-label font-medium text-fg-4">
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
                  active={isActive(row)}
                  activeSubagentId={activeSubagentId}
                  activeShellId={activeShellId}
                  actions={rowActions?.(row)}
                  now={now}
                  showGateway={(gatewayCount ?? rowGateways) > 1 && config.groupBy !== 'gateway'}
                  showProject={config.groupBy !== 'project'}
                  subagents={config.subagents}
                  shells={config.shells}
                  tasks={config.tasks}
                  projectIcons={projectIcons}
                  onSelect={onSelect}
                  onDelete={onDelete}
                  onRename={onRename}
                  onClearContext={onClearContext}
                  onSelectSubagent={onSelectSubagent}
                  onSelectTask={onSelectTask}
                  onStopTask={onStopTask}
                  onSelectShell={onSelectShell}
                  onKillShell={onKillShell}
                  onShellAgentWrite={onShellAgentWrite}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function iconSrcOf(row: SessionRow | undefined, icons: Record<string, string> | undefined): string | undefined {
  const icon = row?.info.project?.icon
  return icon?.type === 'image' ? icons?.[icon.hash] : undefined
}

interface SessionRowItemProps {
  row: SessionRow
  active?: boolean
  actions?: ReactNode
  activeSubagentId?: string
  activeShellId?: string
  now?: number
  showGateway?: boolean
  showProject?: boolean
  subagents?: SubagentDisplay
  shells?: StepDisplay
  tasks?: StepDisplay
  projectIcons?: Record<string, string>
  onSelect?: (row: SessionRow, modifiers: SelectModifiers) => void
  onDelete?: (row: SessionRow) => void
  onRename?: (row: SessionRow, title: string) => void
  onClearContext?: (row: SessionRow) => void
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  onSelectTask?: (row: SessionRow, task: SessionTask) => void
  onStopTask?: (row: SessionRow, toolUseId: string) => void
  onSelectShell?: (row: SessionRow, shellId: string) => void
  onKillShell?: (row: SessionRow, shellId: string) => void
  onShellAgentWrite?: (row: SessionRow, shellId: string, enabled: boolean) => void
}

function SessionRowItem({
  row,
  active,
  actions,
  activeSubagentId,
  activeShellId,
  now,
  showGateway,
  showProject = true,
  subagents,
  shells,
  tasks,
  projectIcons,
  onSelect,
  onDelete,
  onRename,
  onClearContext,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
}: SessionRowItemProps) {
  const { info } = row
  const [editing, setEditing] = useState(false)

  return (
    <SessionItem
      row={row}
      active={active === true}
      activeStepKey={active ? (activeShellId ?? activeSubagentId) : undefined}
      now={now}
      showGateway={showGateway}
      showProject={showProject}
      subagents={subagents}
      shells={shells}
      tasks={tasks}
      projectIcons={projectIcons}
      onSelect={(modifiers) => onSelect?.(row, modifiers)}
      onSelectSubagent={onSelectSubagent ? (id) => onSelectSubagent(row, id) : undefined}
      onSelectTask={onSelectTask ? (task) => onSelectTask(row, task) : undefined}
      onStopTask={onStopTask ? (id) => onStopTask(row, id) : undefined}
      onSelectShell={onSelectShell ? (id) => onSelectShell(row, id) : undefined}
      onKillShell={onKillShell ? (id) => onKillShell(row, id) : undefined}
      onShellAgentWrite={onShellAgentWrite ? (id, enabled) => onShellAgentWrite(row, id, enabled) : undefined}
      onRename={onRename ? (title) => onRename(row, title) : undefined}
      renameOn={actions === undefined ? 'external' : 'doubleClick'}
      editing={actions === undefined ? editing : undefined}
      onEditingChange={actions === undefined ? setEditing : undefined}
      actions={
        actions ?? (
          <>
            {onRename && !editing ? (
              <RowAction label="Rename session" onClick={() => setEditing(true)}>
                <Pencil className="size-3 text-fg-3" />
              </RowAction>
            ) : null}
            {onClearContext && info.capabilities?.clearContext ? (
              <RowAction
                label="Clear context"
                title="Clear the conversation - the session keeps running and the old conversation stays resumable"
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
        )
      }
    />
  )
}

function RowAction({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: ReactNode }) {
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

export function SessionSearch({
  value,
  onChange,
  autoFocus,
  className,
  inputClassName,
}: {
  value: string
  onChange: (value: string) => void
  autoFocus?: boolean
  className?: string
  inputClassName?: string
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-fg-4" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation()
            onChange('')
          }
        }}
        placeholder="Search sessions"
        aria-label="Search sessions"
        autoFocus={autoFocus}
        className={cn('pr-7 pl-8', inputClassName)}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-3.5 -translate-y-1/2 rounded p-0.5 text-fg-4 hover:text-fg-1"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </div>
  )
}
