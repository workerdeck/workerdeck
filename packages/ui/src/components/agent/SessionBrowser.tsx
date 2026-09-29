import { useMemo, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { Eraser, FolderOpen, Layers, Pencil, Plus, Search, SearchX, Trash2, X } from 'lucide-react'
import { clearFilters, filterRows, groupRows, hasFacetFilter, scopeActive, sessionKey, subsetSummary } from '@workerdeck/protocol'
import type { SessionGroup, SessionRow, SessionTask, StepDisplay, SubagentDisplay, ViewConfig, WorkspaceScope } from '@workerdeck/protocol'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { Input } from '../ui/Input.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionFilters } from './SessionFilters.tsx'
import { SessionItem, type SelectModifiers } from './SessionItem.tsx'
import { CustomGroupHeader, GroupHeading, HeadingAction, NewGroupButton, useGroupDrag } from './SessionGroups.tsx'
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
  // Draws a `+` on each project heading: start a session on that gateway, in that project's root.
  onCreateInGroup?: (target: GroupTarget) => void
  emptyState?: ReactNode
  // The facet controls, drawn inline. A host with a header puts `SessionFiltersButton` there instead.
  showControls?: boolean
  showSearch?: boolean
  autoFocusSearch?: boolean
  projectIcons?: Record<string, string>
  className?: string
}

export type GroupTarget = { hostId: string; cwd?: string }

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
  onCreateInGroup,
  emptyState,
  showControls = true,
  showSearch = showControls,
  autoFocusSearch,
  projectIcons,
  className,
}: SessionBrowserProps) {
  const rowGateways = useMemo(() => new Set(rows.map((row) => row.hostId)).size, [rows])
  const gateways = gatewayCount ?? rowGateways
  const visible = useMemo(() => filterRows(rows, config, scope), [rows, config, scope])
  const groups = useMemo(() => groupRows(visible, config, { gatewayCount: gateways }), [visible, config, gateways])
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  const custom = config.groupBy === 'custom'
  const [editingGroup, setEditingGroup] = useState<string>()

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })
  const drag = useGroupDrag(config.customGroups ?? [], (customGroups) => set({ customGroups }))

  const heading = (group: SessionGroup) => {
    if (custom) {
      return (
        <CustomGroupHeader
          group={group}
          editing={group.custom !== undefined && editingGroup === group.custom}
          onEditingChange={(editing) => setEditingGroup(editing ? group.custom : undefined)}
          onRename={(name) => group.custom && drag.rename(group.custom, name)}
          onRemove={() => group.custom && drag.remove(group.custom)}
          dragProps={drag.header(group)}
        />
      )
    }
    if (config.groupBy === 'none' || !group.label) {
      return null
    }
    const project = config.groupBy === 'project'
    const target = project && group.hostId ? { hostId: group.hostId, cwd: group.cwd } : undefined
    return (
      <GroupHeading
        label={group.label}
        count={group.rows.length}
        title={project && group.cwd ? group.cwd : undefined}
        leading={
          project ? (
            <ProjectIcon icon={group.rows[0]?.info.project?.icon} src={iconSrcOf(group.rows[0], projectIcons)} name={group.label} />
          ) : undefined
        }
        actions={
          target && onCreateInGroup ? (
            <HeadingAction label={`New session in ${group.label}`} onClick={() => onCreateInGroup(target)}>
              <Plus className="size-3" />
            </HeadingAction>
          ) : undefined
        }
      />
    )
  }

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
            <div
              key={group.key}
              {...(custom ? drag.container(group) : {})}
              className={cn('flex flex-col gap-1 rounded-md', custom && drag.isOver(`group:${group.key}`) && 'bg-row-hover/50')}
            >
              {heading(group)}
              {custom && group.custom !== undefined && group.rows.length === 0 ? (
                <div className="mx-1 rounded-md border border-dashed border-border px-2 py-2 text-center text-label text-fg-4">
                  Drag sessions here
                </div>
              ) : null}
              {group.rows.map((row) => (
                <SessionRowItem
                  key={sessionKey(row)}
                  dragProps={custom ? drag.session(sessionKey(row), group) : undefined}
                  dropTarget={custom && drag.isOver(`row:${sessionKey(row)}`)}
                  row={row}
                  active={isActive(row)}
                  activeSubagentId={activeSubagentId}
                  activeShellId={activeShellId}
                  actions={rowActions?.(row)}
                  now={now}
                  showGateway={gateways > 1 && config.groupBy !== 'project'}
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
          {custom ? <NewGroupButton onClick={() => setEditingGroup(drag.create())} /> : null}
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
  dragProps?: HTMLAttributes<HTMLDivElement>
  dropTarget?: boolean
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
  dragProps,
  dropTarget,
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

  const item = (
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
  if (!dragProps) {
    return item
  }
  return (
    <div {...dragProps} className={cn('rounded-md', dropTarget && 'shadow-[inset_0_2px_0_0_var(--color-accent)]')}>
      {item}
    </div>
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
