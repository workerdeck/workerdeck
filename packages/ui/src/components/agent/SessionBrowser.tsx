import { useMemo, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { BedDouble, ChevronDown, ChevronRight, Eraser, FolderOpen, Layers, Pencil, Plus, Search, SearchX, Trash2, X } from 'lucide-react'
import {
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  relayHostsOf,
  isTeamCollapsed,
  scopeActive,
  sessionKey,
  subsetSummary,
  teamSummary,
  toggleTeamCollapsed,
} from '@workerdeck/protocol'
import type {
  HostRelays,
  SessionGroup,
  SessionRow,
  SessionState,
  SessionTask,
  StepDisplay,
  SubagentDisplay,
  ViewConfig,
  WorkspaceScope,
} from '@workerdeck/protocol'
import { AgentAvatar, avatarOf, type AgentAvatars } from './AgentAvatar.tsx'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { Input } from '../ui/Input.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionFilters } from './SessionFilters.tsx'
import { SessionItem, type SelectModifiers } from './SessionItem.tsx'
import { CustomGroupHeader, GroupHeading, HeadingAction, NewGroupButton, useGroupDrag, type DropCue } from './SessionGroups.tsx'
import type { TeamMove } from '../../lib/team-drop.ts'
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
  // An agent card's name is the agent's, not the session title; without this, agent cards are not renamable.
  onRenameAgent?: (row: SessionRow, name: string) => void
  onClearContext?: (row: SessionRow) => void
  onSleep?: (row: SessionRow) => void
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  onSelectTask?: (row: SessionRow, task: SessionTask) => void
  onStopTask?: (row: SessionRow, toolUseId: string) => void
  onSelectShell?: (row: SessionRow, shellId: string) => void
  onKillShell?: (row: SessionRow, shellId: string) => void
  onShellAgentWrite?: (row: SessionRow, shellId: string, enabled: boolean) => void
  avatars?: AgentAvatars
  // Makes cards draggable onto each other: the middle of a card joins its team, a member dropped outside leaves.
  // Reject with an Error to draw its message under the card.
  onTeamMove?: (move: TeamMove) => Promise<void> | void
  // Each gateway's `GatewayMeta.relay` by host id: draws a member under a lead on another gateway, and allows the drop.
  relays?: HostRelays
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
  onRenameAgent,
  onClearContext,
  onSleep,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
  avatars,
  onTeamMove,
  relays,
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
  const relayHosts = useMemo(() => relayHostsOf(relays ?? {}), [relays])
  const groups = useMemo(
    () => groupRows(visible, config, { gatewayCount: gateways, all: rows, relayHosts }),
    [visible, config, gateways, rows, relayHosts],
  )
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  const tiles = useMemo(() => rows.some((row) => row.info.agent !== undefined), [rows])
  const custom = config.groupBy === 'custom'
  const [editingGroup, setEditingGroup] = useState<string>()

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })
  const byKey = useMemo(() => new Map(rows.map((row) => [sessionKey(row), row])), [rows])
  const drag = useGroupDrag(config.customGroups ?? [], (customGroups) => set({ customGroups }), {
    custom,
    team: onTeamMove ? { rowOf: (key) => byKey.get(key), onMove: onTeamMove, relays } : undefined,
  })
  const draggable = custom || onTeamMove !== undefined

  const heading = (group: SessionGroup) => {
    if (custom) {
      return (
        <CustomGroupHeader
          group={group}
          look={config.customGroups?.find((custom) => custom.id === group.custom)}
          onStyle={(look) => group.custom && drag.style(group.custom, look)}
          editing={group.custom !== undefined && editingGroup === group.custom}
          onEditingChange={(editing) => setEditingGroup(editing ? group.custom : undefined)}
          onRename={(name) => group.custom && drag.rename(group.custom, name)}
          onRemove={() => group.custom && drag.remove(group.custom)}
          dragProps={drag.header(group)}
        />
      )
    }
    if (group.earlier) {
      return (
        <button
          type="button"
          aria-expanded={config.earlierOpen === true}
          onClick={() => set({ earlierOpen: !config.earlierOpen })}
          className="flex items-center gap-1 px-2 text-left text-label text-fg-4 hover:text-fg-2"
        >
          {config.earlierOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Earlier · {group.rows.length} one-off session{group.rows.length === 1 ? '' : 's'}
        </button>
      )
    }
    if (config.groupBy === 'none' || !group.label) {
      return null
    }
    const project = config.groupBy === 'project'
    const target = project && group.hostId ? { hostId: group.hostId, cwd: group.cwd } : undefined
    return (
      <GroupHeading
        label={
          group.gateway && group.project ? (
            <>
              {group.gateway}
              <span aria-hidden> · </span>
              <span className="text-fg-1">{group.project}</span>
            </>
          ) : (
            group.label
          )
        }
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
        <div className="flex flex-col gap-2 px-1">
          {groups.map((group) => (
            <div
              key={group.key}
              {...(draggable ? drag.container(group) : {})}
              className={cn('flex flex-col gap-1 rounded-md', draggable && drag.isOver(`group:${group.key}`) && 'bg-row-hover/50')}
            >
              {heading(group)}
              {custom && group.custom !== undefined && group.rows.length === 0 ? (
                <div className="mx-1 rounded-md border border-dashed border-border px-2 py-2 text-center text-label text-fg-4">
                  Drag sessions here
                </div>
              ) : null}
              {group.earlier && !config.earlierOpen
                ? null
                : group.rows.map((row) => {
                    const item = (member: SessionRow, variant: 'card' | 'member', extra: Partial<SessionRowItemProps> = {}) => (
                      <SessionRowItem
                        key={sessionKey(member)}
                        dragProps={
                          onTeamMove || (custom && variant === 'card')
                            ? drag.session(sessionKey(member), group, variant === 'member' ? { row: member, lead: row } : { row })
                            : undefined
                        }
                        dropCue={draggable ? drag.cue(sessionKey(member)) : undefined}
                        row={member}
                        variant={variant}
                        active={isActive(member)}
                        activeSubagentId={activeSubagentId}
                        activeShellId={activeShellId}
                        actions={rowActions?.(member)}
                        now={now}
                        showGateway={gateways > 1 && config.groupBy !== 'project'}
                        showProject={config.groupBy !== 'project'}
                        subagents={config.subagents}
                        shells={config.shells}
                        tasks={config.tasks}
                        projectIcons={projectIcons}
                        avatars={avatars}
                        tile={tiles}
                        onSelect={onSelect}
                        onDelete={onDelete}
                        onRename={member.info.agent ? onRenameAgent : onRename}
                        onClearContext={onClearContext}
                        onSleep={onSleep}
                        onSelectSubagent={onSelectSubagent}
                        onSelectTask={onSelectTask}
                        onStopTask={onStopTask}
                        onSelectShell={onSelectShell}
                        onKillShell={onKillShell}
                        onShellAgentWrite={onShellAgentWrite}
                        {...extra}
                      />
                    )
                    if (!row.members?.length) {
                      return item(row, 'card', { className: row.context ? 'opacity-50' : undefined })
                    }
                    const collapsed = isTeamCollapsed(config, row)
                    return (
                      <TeamBlock
                        key={sessionKey(row)}
                        lead={row}
                        collapsed={collapsed}
                        avatars={avatars}
                        onToggle={() => onConfigChange(toggleTeamCollapsed(config, row))}
                        renderLead={(summary, tray) =>
                          item(row, 'card', {
                            className: row.context ? 'opacity-50' : undefined,
                            badgeState: collapsed ? row.teamState : undefined,
                            teamUnseen: collapsed ? summary.unseen : 0,
                            teamTray: tray,
                          })
                        }
                        renderMember={(member) => item(member, 'member')}
                      />
                    )
                  })}
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
  variant?: 'card' | 'member'
  avatars?: AgentAvatars
  badgeState?: SessionState
  teamUnseen?: number
  teamTray?: ReactNode
  tile?: boolean
  className?: string
  dragProps?: HTMLAttributes<HTMLDivElement>
  dropCue?: DropCue
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
  onSleep?: (row: SessionRow) => void
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  onSelectTask?: (row: SessionRow, task: SessionTask) => void
  onStopTask?: (row: SessionRow, toolUseId: string) => void
  onSelectShell?: (row: SessionRow, shellId: string) => void
  onKillShell?: (row: SessionRow, shellId: string) => void
  onShellAgentWrite?: (row: SessionRow, shellId: string, enabled: boolean) => void
}

function SessionRowItem({
  row,
  variant,
  avatars,
  badgeState,
  teamUnseen,
  teamTray,
  tile,
  className,
  dragProps,
  dropCue,
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
  onSleep,
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
      variant={variant}
      avatars={avatars}
      badgeState={badgeState}
      teamUnseen={teamUnseen}
      teamTray={teamTray}
      tile={tile}
      className={className}
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
              <RowAction label={info.agent ? 'Rename agent' : 'Rename session'} onClick={() => setEditing(true)}>
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
            {onSleep && info.capabilities?.engineSleep && info.status === 'idle' && !info.engineAsleep ? (
              <RowAction
                label="Sleep session"
                title="Stop the engine process to free its memory - the session stays here and wakes on your next message"
                onClick={() => onSleep(row)}
              >
                <BedDouble className="size-3 text-fg-3" />
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
  const zone = dropCue?.zone
  return (
    <div
      {...dragProps}
      title={zone === 'refused' ? dropCue?.message : undefined}
      className={cn(
        'rounded-md',
        zone === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
        zone === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-accent)]',
        zone === 'join' && 'bg-accent/10 ring-1 ring-accent',
        zone === 'refused' && 'ring-1 ring-danger/60',
      )}
    >
      {item}
      {zone === 'refused' && dropCue?.message ? (
        <div role="status" className="px-3 pb-1 text-label text-danger">
          {dropCue.message}
        </div>
      ) : null}
    </div>
  )
}

const TRAY_MAX = 4

// A folded team draws its members on the lead's first line (avatar and status each) and no row of its own; the tray
// unfolds it. Expanded, a tree line runs from the lead's avatar with the knob atop it, so neither state needs a twistie.
function TeamBlock({
  lead,
  collapsed,
  avatars,
  onToggle,
  renderLead,
  renderMember,
}: {
  lead: SessionRow
  collapsed: boolean
  avatars?: AgentAvatars
  onToggle: () => void
  renderLead: (summary: ReturnType<typeof teamSummary>, tray?: ReactNode) => ReactNode
  renderMember: (member: SessionRow) => ReactNode
}) {
  const members = lead.members ?? []
  const summary = teamSummary(lead)
  if (collapsed) {
    const surfaced = members.filter((member) => member.state === 'attention')
    const counts = [
      `${summary.members} member${summary.members === 1 ? '' : 's'}`,
      summary.working ? `${summary.working} working` : undefined,
      summary.attention ? `${summary.attention} need${summary.attention === 1 ? 's' : ''} you` : undefined,
    ].filter(Boolean)
    const hidden = members.length - TRAY_MAX
    const tray = (
      <button
        type="button"
        aria-expanded={false}
        aria-label={`Expand ${lead.info.agent?.name ?? 'team'}: ${counts.join(', ')}`}
        title={counts.join(' · ')}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className="flex shrink-0 items-center gap-1 rounded-[4px] px-0.5 hover:bg-row-hover"
      >
        {members.slice(0, hidden > 0 ? TRAY_MAX - 1 : TRAY_MAX).map((member) => (
          <AgentAvatar
            key={sessionKey(member)}
            row={member}
            image={avatarOf(avatars, member.info.agent)}
            size={16}
            className="rounded-[3px]"
          />
        ))}
        {hidden > 0 ? <span className="text-label text-fg-4 tabular-nums">+{hidden + 1}</span> : null}
      </button>
    )
    return (
      <div data-slot="team" data-collapsed className="flex flex-col">
        {renderLead(summary, tray)}
        {surfaced.length ? <div className="ml-3 flex flex-col">{surfaced.map(renderMember)}</div> : null}
      </div>
    )
  }
  return (
    <div data-slot="team" className="flex flex-col">
      {renderLead(summary)}
      <div className="relative ml-3.5 flex flex-col pl-1">
        <span aria-hidden className="absolute top-0 bottom-3 left-0 w-px bg-border" />
        <button
          type="button"
          aria-expanded
          aria-label={`Collapse ${lead.info.agent?.name ?? 'team'}`}
          onClick={onToggle}
          className="absolute -top-1 -left-[7px] flex size-3.5 items-center justify-center rounded-full border border-border bg-bg text-fg-4 hover:text-fg-1"
        >
          <ChevronDown className="size-2.5" />
        </button>
        {members.map(renderMember)}
      </div>
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
