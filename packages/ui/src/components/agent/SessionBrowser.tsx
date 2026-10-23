import { useEffect, useMemo, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import { BedDouble, ChevronDown, ChevronRight, FolderOpen, Layers, Pencil, Plus, RotateCcw, Search, SearchX, Trash2, X } from 'lucide-react'
import {
  clearFilters,
  filterRows,
  groupRows,
  hasFacetFilter,
  relayHostsOf,
  scopeActive,
  sessionKey,
  sessionLabel,
  subsetSummary,
  teamLingerEnds,
  teamLingerStart,
  TEAM_LINGER_MS,
  teamView,
  toggleTeamExpanded,
  expandedStepsOf,
  isGroupCollapsed,
  moveGroup,
  orderGroups,
  orderedGroupBy,
  toggleGroupCollapsed,
  toggleStepsExpanded,
  clearContextOffered,
  newConversationGate,
  NEW_CONVERSATION_HINT,
} from '@workerdeck/protocol'
import type {
  FoldableStepKind,
  HostRelays,
  SessionGroup,
  SessionRow,
  SessionTask,
  StepDisplay,
  SubagentDisplay,
  TeamView,
  ViewConfig,
  WorkspaceScope,
} from '@workerdeck/protocol'
import { AgentAvatar, avatarOf, type AgentAvatars } from './AgentAvatar.tsx'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { HoverCard } from '../ui/HoverCard.tsx'
import { Input } from '../ui/Input.tsx'
import { MemberCard } from './MemberCard.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionFilters } from './SessionFilters.tsx'
import { SessionItem, type SelectModifiers } from './SessionItem.tsx'
import { CustomGroupHeader, FacetGroupHeader, HeadingAction, NewGroupButton, useGroupDrag, type DropCue } from './SessionGroups.tsx'
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
  onNewConversation?: (row: SessionRow) => void
  onSleep?: (row: SessionRow) => void
  onSelectSubagent?: (row: SessionRow, toolUseId: string) => void
  onSelectTask?: (row: SessionRow, task: SessionTask) => void
  onStopTask?: (row: SessionRow, toolUseId: string) => void
  onSelectShell?: (row: SessionRow, shellId: string) => void
  onKillShell?: (row: SessionRow, shellId: string) => void
  onShellAgentWrite?: (row: SessionRow, shellId: string, enabled: boolean) => void
  avatars?: AgentAvatars
  // A "Conversations" link on an agent's hover card.
  onAgentConversations?: (row: SessionRow) => void
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
  onNewConversation,
  onSleep,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
  onAgentConversations,
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
    () => orderGroups(groupRows(visible, config, { gatewayCount: gateways, all: rows, relayHosts }), config),
    [visible, config, gateways, rows, relayHosts],
  )
  const subset = subsetSummary(config, scope, visible.length, rows.length)
  const tiles = useMemo(() => rows.some((row) => row.info.agent !== undefined), [rows])
  const custom = config.groupBy === 'custom'
  const [editingGroup, setEditingGroup] = useState<string>()
  const [tick, setTick] = useState(() => Date.now())
  const clock = now ?? tick
  const [peeked, setPeeked] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const next = new Set(peeked)
    for (const group of groups) {
      for (const member of group.rows.flatMap((row) => row.members ?? [])) {
        if (member.state === 'working' || member.state === 'attention') {
          next.delete(sessionKey(member))
        } else if (isActive(member)) {
          next.add(sessionKey(member))
        }
      }
    }
    if (next.size !== peeked.size || [...next].some((key) => !peeked.has(key))) {
      setPeeked(next)
    }
  }, [groups, isActive, peeked])
  const views = useMemo(() => {
    const out = new Map<string, TeamView>()
    for (const group of groups) {
      for (const row of group.rows) {
        if (row.members?.length) {
          const selected = row.members.find(isActive)
          out.set(sessionKey(row), teamView(row, config, selected && sessionKey(selected), clock, peeked))
        }
      }
    }
    return out
  }, [groups, config, isActive, clock, peeked])
  const lingerEnds = useMemo(() => {
    const ends = [...views.values()].map((view) => teamLingerEnds(view, clock)).filter((end) => end !== undefined)
    return ends.length ? Math.min(...ends) : undefined
  }, [views, clock])
  useEffect(() => {
    if (now !== undefined || lingerEnds === undefined) {
      return
    }
    const timer = setTimeout(() => setTick(Date.now()), Math.max(0, lingerEnds - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [now, lingerEnds])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })
  const byKey = useMemo(() => new Map(rows.map((row) => [sessionKey(row), row])), [rows])
  const ordered = orderedGroupBy(config.groupBy)
  const drag = useGroupDrag(config.customGroups ?? [], (customGroups) => set({ customGroups }), {
    custom,
    team: onTeamMove ? { rowOf: (key) => byKey.get(key), onMove: onTeamMove, relays } : undefined,
    order: ordered ? (key, onto) => onConfigChange(moveGroup(config, groups, key, onto)) : undefined,
  })
  const draggable = custom || ordered || onTeamMove !== undefined
  const folded = (group: SessionGroup) => !group.earlier && config.groupBy !== 'none' && isGroupCollapsed(config, group)

  const heading = (group: SessionGroup) => {
    if (custom) {
      return (
        <CustomGroupHeader
          group={group}
          look={config.customGroups?.find((stored) => stored.id === group.custom)}
          onStyle={(look) => group.custom && drag.style(group.custom, look)}
          editing={group.custom !== undefined && editingGroup === group.custom}
          onEditingChange={(editing) => setEditingGroup(editing ? group.custom : undefined)}
          onRename={(name) => group.custom && drag.rename(group.custom, name)}
          onRemove={() => group.custom && drag.remove(group.custom)}
          dragProps={drag.header(group)}
          collapsed={isGroupCollapsed(config, group)}
          onToggleCollapsed={() => onConfigChange(toggleGroupCollapsed(config, group))}
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
    const label = project ? (group.project ?? group.label) : group.label
    return (
      <FacetGroupHeader
        group={group}
        label={label}
        caps={!project}
        badge={project ? group.gateway : undefined}
        title={project && group.cwd ? group.cwd : undefined}
        icon={
          project ? (
            <ProjectIcon icon={group.rows[0]?.info.project?.icon} src={iconSrcOf(group.rows[0], projectIcons)} name={label} />
          ) : undefined
        }
        actions={
          target && onCreateInGroup ? (
            <HeadingAction label={`New session in ${label}`} onClick={() => onCreateInGroup(target)}>
              <Plus className="size-3" />
            </HeadingAction>
          ) : undefined
        }
        dragProps={drag.header(group)}
        collapsed={isGroupCollapsed(config, group)}
        onToggleCollapsed={() => onConfigChange(toggleGroupCollapsed(config, group))}
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
              {folded(group) ? null : custom && group.custom !== undefined && group.rows.length === 0 ? (
                <div className="mx-1 rounded-md border border-dashed border-border px-2 py-2 text-center text-label text-fg-4">
                  Drag sessions here
                </div>
              ) : null}
              {(group.earlier && !config.earlierOpen) || folded(group)
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
                        expandedSteps={expandedStepsOf(config, member)}
                        onToggleSteps={(kind) => onConfigChange(toggleStepsExpanded(config, member, kind))}
                        projectIcons={projectIcons}
                        avatars={avatars}
                        tile={tiles}
                        onSelect={onSelect}
                        onDelete={onDelete}
                        onRename={member.info.agent ? onRenameAgent : onRename}
                        onNewConversation={onNewConversation}
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
                    return (
                      <TeamBlock
                        key={sessionKey(row)}
                        lead={row}
                        view={views.get(sessionKey(row)) ?? { expanded: false, shown: row.members, tray: [] }}
                        avatars={avatars}
                        selected={row.members.find(isActive)}
                        peeked={peeked}
                        now={now}
                        onToggle={() => onConfigChange(toggleTeamExpanded(config, row))}
                        onSelectMember={(member) => onSelect?.(member, { meta: false, ctrl: false, alt: false })}
                        onConversations={onAgentConversations}
                        renderLead={(tray) => item(row, 'card', { className: row.context ? 'opacity-50' : undefined, teamTray: tray })}
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
  expandedSteps?: readonly FoldableStepKind[]
  onToggleSteps?: (kind: FoldableStepKind) => void
  projectIcons?: Record<string, string>
  onSelect?: (row: SessionRow, modifiers: SelectModifiers) => void
  onDelete?: (row: SessionRow) => void
  onRename?: (row: SessionRow, title: string) => void
  onNewConversation?: (row: SessionRow) => void
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
  expandedSteps,
  onToggleSteps,
  projectIcons,
  onSelect,
  onDelete,
  onRename,
  onNewConversation,
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
      expandedSteps={expandedSteps}
      onToggleSteps={onToggleSteps}
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
            {onNewConversation && clearContextOffered(info) && newConversationGate(info).enabled ? (
              <RowAction
                label="New conversation"
                title={`New conversation: ${NEW_CONVERSATION_HINT.toLowerCase()}`}
                onClick={() => onNewConversation(row)}
              >
                <RotateCcw className="size-3 text-fg-3" />
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

// Auto draws the members `teamView` shows under the lead and the rest as a tray on its first line: an avatar selects
// that member, the trailing `+N` or chevron expands the team. Expanded, the knob atop the tree line returns it to Auto.
function TeamBlock({
  lead,
  view,
  avatars,
  selected,
  peeked,
  now,
  onToggle,
  onSelectMember,
  onConversations,
  renderLead,
  renderMember,
}: {
  lead: SessionRow
  view: TeamView
  avatars?: AgentAvatars
  selected?: SessionRow
  peeked?: ReadonlySet<string>
  now?: number
  onToggle: () => void
  onSelectMember: (member: SessionRow) => void
  onConversations?: (member: SessionRow) => void
  renderLead: (tray?: ReactNode) => ReactNode
  renderMember: (member: SessionRow) => ReactNode
}) {
  const team = lead.info.agent?.name ?? 'team'
  const overflow = view.tray.length > TRAY_MAX
  const avatarsShown = view.tray.slice(0, overflow ? TRAY_MAX - 1 : TRAY_MAX)
  const tray = view.tray.length ? (
    <span className="flex shrink-0 items-center gap-1">
      {avatarsShown.map((member) => {
        const name = member.info.agent?.name ?? sessionLabel(member.info)
        return (
          <HoverCard
            key={sessionKey(member)}
            trigger={
              <button
                type="button"
                aria-label={`Select ${name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectMember(member)
                }}
                className="flex shrink-0 rounded-[3px] hover:ring-1 hover:ring-border"
              >
                <AgentAvatar row={member} image={avatarOf(avatars, member.info.agent)} size={16} title="" className="rounded-[3px]" />
              </button>
            }
          >
            <MemberCard member={member} avatars={avatars} onConversations={onConversations ? () => onConversations(member) : undefined} />
          </HoverCard>
        )
      })}
      <button
        type="button"
        aria-expanded={false}
        aria-label={`Show all Team Members of ${team}`}
        title={`${view.tray.length} more Member${view.tray.length === 1 ? '' : 's'}`}
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        className="flex h-4 shrink-0 items-center rounded-[4px] px-0.5 text-label text-fg-4 tabular-nums hover:bg-row-hover hover:text-fg-1"
      >
        {overflow ? `+${view.tray.length - avatarsShown.length}` : <ChevronRight className="size-3" />}
      </button>
    </span>
  ) : undefined
  return (
    <div data-slot="team" data-expanded={view.expanded || undefined} className="flex flex-col">
      {renderLead(tray)}
      {view.shown.length ? (
        <div className="relative ml-3.5 flex flex-col pl-1">
          <span aria-hidden className="absolute top-0 bottom-3 left-0 w-px bg-border" />
          {view.expanded ? (
            <button
              type="button"
              aria-expanded
              aria-label={`Show only active Team Members of ${team}`}
              title="Show only active Members"
              onClick={onToggle}
              className="absolute -top-1 -left-[7px] flex size-3.5 items-center justify-center rounded-full border border-border bg-bg text-fg-4 hover:text-fg-1"
            >
              <ChevronDown className="size-2.5" />
            </button>
          ) : null}
          {view.shown.map((member) => (
            <div key={sessionKey(member)} className="relative">
              {renderMember(member)}
              <LingerBar member={member} selected={selected} peeked={peeked} now={now} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

// A member Auto keeps only for its linger window: a hairline fills left to right and the row leaves when it is full.
function LingerBar({
  member,
  selected,
  peeked,
  now,
}: {
  member: SessionRow
  selected?: SessionRow
  peeked?: ReadonlySet<string>
  now?: number
}) {
  const clock = now ?? Date.now()
  const start = teamLingerStart(member, selected && sessionKey(selected), clock, peeked)
  if (start === undefined) {
    return null
  }
  return (
    <span
      aria-hidden
      title="Idle, leaving the list soon"
      className="wd-linger pointer-events-none absolute right-2 bottom-0 left-2 h-0.5 rounded-full bg-fg-4/50"
      style={{ animationDuration: `${TEAM_LINGER_MS}ms`, animationDelay: `${start - clock}ms` }}
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
