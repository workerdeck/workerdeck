import { Fragment, useMemo, useState } from 'react'
import type { HTMLAttributes, ReactNode } from 'react'
import {
  BedDouble,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  Layers,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  X,
} from 'lucide-react'
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
  teamSummary,
  teamSummaryText,
  teamView,
  toggleTeamExpanded,
  expandedStepsOf,
  isGroupCollapsed,
  addCustomGroup,
  moveCustomGroup,
  moveToCustomGroup,
  newCustomGroupId,
  removeCustomGroup,
  renameCustomGroup,
  styleCustomGroup,
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
import { AgentAvatar } from './AgentAvatar.tsx'
import { Button } from '../ui/Button.tsx'
import { Empty } from '../ui/Empty.tsx'
import { HoverCard } from '../ui/HoverCard.tsx'
import { Input } from '../ui/Input.tsx'
import { MemberCard } from './MemberCard.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionFilters } from './SessionFilters.tsx'
import { SessionItem, type SelectModifiers } from './SessionItem.tsx'
import { CustomGroupHeader, FacetGroupHeader, HeadingAction, NewGroupButton } from './SessionGroups.tsx'
import { useListDrag, type DragCue, type DragItem } from './use-list-drag.tsx'
import { joinDrop, memberDrop, type TeamMove } from '../../lib/team-drop.ts'
import { groupSlot, placeGroup, sameSlot, sessionTarget, type DragTarget, type Slot } from '../../lib/row-drag.ts'
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
  showTime?: boolean
  rowAttributes?: (row: SessionRow) => Record<`data-${string}`, string>
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
  // A "Conversations" link on an agent's hover card.
  onAgentConversations?: (row: SessionRow) => void
  // Makes cards draggable onto each other: the middle of an agent's card joins its team, a member dragged out of its team leaves.
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
  showTime = true,
  rowAttributes,
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
  const views = useMemo(() => {
    const out = new Map<string, TeamView>()
    for (const group of groups) {
      for (const row of group.rows) {
        if (row.members?.length) {
          const selected = row.members.find(isActive)
          out.set(sessionKey(row), teamView(row, config, selected && sessionKey(selected)))
        }
      }
    }
    return out
  }, [groups, config, isActive])

  const set = (patch: Partial<ViewConfig>) => onConfigChange({ ...config, ...patch })
  const byKey = useMemo(() => new Map(rows.map((row) => [sessionKey(row), row])), [rows])
  const ordered = orderedGroupBy(config.groupBy)
  const customGroups = config.customGroups ?? []
  const setCustom = (next: ViewConfig['customGroups']) => set({ customGroups: next })
  const groupByLane = new Map(groups.map((group) => [laneOf(group), group]))
  const groupByDragKey = new Map(groups.map((group) => [groupDragKey(group), group]))

  const move = (key: string, next: TeamMove) => {
    drag.clearFailure()
    void Promise.resolve()
      .then(() => onTeamMove!(next))
      .catch((err: unknown) => drag.fail(key, err))
  }

  const resolveSession = (
    item: Extract<DragItem, { kind: 'session' }>,
    rowsAt: Parameters<typeof sessionTarget>[0],
    y: number,
    current: DragTarget,
    origin: Slot,
    team?: { top: number; bottom: number },
  ) => {
    const dragged = byKey.get(item.key)
    const joinable = (target: string) => {
      const lead = byKey.get(target)
      if (!onTeamMove || !dragged || !lead?.info.agent) {
        return undefined
      }
      const result = joinDrop(dragged, lead, relays)
      return typeof result === 'string' ? result : true
    }
    const leadLane = item.lead ? rowsAt.find((row) => row.key === item.lead)?.lane : undefined
    return sessionTarget(rowsAt, y, current, {
      dragged: item.key,
      origin,
      reorder: custom,
      joinable,
      team: item.lead && team && leadLane ? { lane: teamLane(item.lead), lead: item.lead, leadLane, ...team } : undefined,
    })
  }

  const commitGroup = (key: string, slot: Slot) => {
    const before = slot.before === undefined ? undefined : groupByDragKey.get(slot.before)
    const moving = groupByDragKey.get(key)
    if (!moving) {
      return
    }
    if (custom) {
      if (moving.custom !== undefined) {
        setCustom(moveCustomGroup(customGroups, moving.custom, before?.custom))
      }
      return
    }
    onConfigChange(placeGroup(config, groups, moving.key, before && !before.earlier ? before.key : undefined))
  }

  const commitSession = (item: Extract<DragItem, { kind: 'session' }>, target: DragTarget, origin: Slot) => {
    const dragged = byKey.get(item.key)
    if (!dragged || target.refusal) {
      return
    }
    if (target.join) {
      const lead = byKey.get(target.join)
      const result = lead && joinDrop(dragged, lead, relays)
      if (result && typeof result !== 'string') {
        move(target.join, result)
      }
      return
    }
    const group = groupByLane.get(target.slot.lane)
    const place = () => group && setCustom(moveToCustomGroup(customGroups, item.key, group.custom, target.slot.before))
    if (item.lead && target.leave) {
      move(item.key, { row: dragged, lead: null })
      if (custom) {
        place()
      }
      return
    }
    if (sameSlot(target.slot, origin)) {
      return
    }
    const lead = item.lead ? byKey.get(item.lead) : undefined
    if (lead && target.slot.lane === teamLane(item.lead!)) {
      const before = target.slot.before ? byKey.get(target.slot.before) : undefined
      const result = memberDrop(dragged, lead, before ?? lead, 'before', relays)
      if (typeof result === 'string') {
        drag.fail(item.key, new Error(result))
      } else {
        move(item.key, result)
      }
      return
    }
    if (custom) {
      place()
    }
  }

  const drag = useListDrag({
    resolve: (item, geometry, y, current, origin) =>
      item.kind === 'group'
        ? { slot: groupSlot(geometry.rows, y, current.slot, item.key) }
        : resolveSession(item, geometry.rows, y, current, origin, geometry.team),
    commit: (item, target, origin) => (item.kind === 'group' ? commitGroup(item.key, target.slot) : commitSession(item, target, origin)),
  })
  const groupDrag = drag.active?.kind === 'group'
  const sessionDrag = drag.active?.kind === 'session' ? drag.active : undefined
  const groupDraggable = (group: SessionGroup) => (custom ? group.custom !== undefined : ordered && !group.earlier)
  const folded = (group: SessionGroup) => groupDrag || (!group.earlier && config.groupBy !== 'none' && isGroupCollapsed(config, group))
  const headingDrag = (group: SessionGroup): HTMLAttributes<HTMLElement> => {
    if (sessionDrag) {
      return custom ? drag.row(`head:${group.key}`, laneOf(group), 'heading') : {}
    }
    const pinned = group.earlier || (custom && group.custom === undefined)
    return {
      ...drag.row(groupDragKey(group), GROUPS_LANE, pinned ? 'pinned' : 'row'),
      ...(groupDraggable(group) ? drag.grip({ kind: 'group', key: groupDragKey(group) }) : {}),
    }
  }
  const viewOf = (row: SessionRow): TeamView => {
    const members = row.members ?? []
    if (sessionDrag) {
      return sessionDrag.lead === sessionKey(row)
        ? { expanded: true, shown: members, tray: [] }
        : { expanded: false, shown: [], tray: members }
    }
    return views.get(sessionKey(row)) ?? { expanded: false, shown: members, tray: [] }
  }

  const heading = (group: SessionGroup) => {
    if (custom) {
      return (
        <CustomGroupHeader
          group={group}
          look={config.customGroups?.find((stored) => stored.id === group.custom)}
          onStyle={(look) => group.custom && setCustom(styleCustomGroup(customGroups, group.custom, look))}
          editing={group.custom !== undefined && editingGroup === group.custom}
          onEditingChange={(editing) => setEditingGroup(editing ? group.custom : undefined)}
          onRename={(name) => group.custom && setCustom(renameCustomGroup(customGroups, group.custom, name))}
          onRemove={() => group.custom && setCustom(removeCustomGroup(customGroups, group.custom))}
          dragProps={headingDrag(group)}
          draggable={groupDraggable(group)}
          collapsed={folded(group)}
          onToggleCollapsed={() => onConfigChange(toggleGroupCollapsed(config, group))}
        />
      )
    }
    if (group.earlier) {
      return (
        <button
          type="button"
          {...headingDrag(group)}
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
        dragProps={headingDrag(group)}
        draggable={groupDraggable(group)}
        collapsed={folded(group)}
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
        <div ref={drag.root} className={cn('relative flex flex-col gap-2 px-1', drag.active && 'pointer-events-none')}>
          {groups.map((group) => {
            const lane = laneOf(group)
            const hidden = (group.earlier && !config.earlierOpen) || folded(group)
            const item = (
              member: SessionRow,
              variant: 'card' | 'member',
              lead: SessionRow | undefined,
              extra: Partial<SessionRowItemProps> = {},
            ) => {
              const key = sessionKey(member)
              const grabbable = onTeamMove !== undefined || (custom && variant === 'card')
              const handles = grabbable
                ? {
                    ...(lead ? drag.box(key) : member.members?.length ? {} : drag.box(key)),
                    ...drag.row(key, lead ? teamLane(sessionKey(lead)) : lane),
                    ...drag.grip({ kind: 'session', key, lead: lead && sessionKey(lead) }),
                  }
                : undefined
              return (
                <SessionRowItem
                  key={key}
                  dragProps={handles}
                  dropCue={drag.cue(key)}
                  nameOf={(other) => {
                    const row = byKey.get(other)
                    return row ? (row.info.agent?.name ?? sessionLabel(row.info)) : other
                  }}
                  row={member}
                  variant={variant}
                  active={isActive(member)}
                  activeSubagentId={activeSubagentId}
                  activeShellId={activeShellId}
                  actions={rowActions?.(member)}
                  now={now}
                  showTime={showTime}
                  rootAttributes={rowAttributes?.(member)}
                  showGateway={gateways > 1 && config.groupBy !== 'project'}
                  showProject={config.groupBy !== 'project'}
                  subagents={config.subagents}
                  shells={config.shells}
                  tasks={config.tasks}
                  expandedSteps={expandedStepsOf(config, member)}
                  onToggleSteps={(kind) => onConfigChange(toggleStepsExpanded(config, member, kind))}
                  projectIcons={projectIcons}
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
            }
            const emptyBox =
              !groupDrag &&
              custom &&
              group.custom !== undefined &&
              group.rows.length === 0 &&
              !hidden &&
              drag.active?.target?.slot.lane !== lane
            return (
              <Fragment key={group.key}>
                {drag.spacer(GROUPS_LANE, groupDragKey(group))}
                <div {...drag.box(groupDragKey(group))} className={cn('flex flex-col gap-1 rounded-md', LIFTED)}>
                  {heading(group)}
                  {!emptyBox ? null : (
                    <div
                      {...(sessionDrag ? drag.row(`empty:${group.key}`, lane, 'empty') : {})}
                      className="mx-1 rounded-md border border-dashed border-border px-2 py-2 text-center text-label text-fg-4"
                    >
                      Drag sessions here
                    </div>
                  )}
                  {hidden
                    ? null
                    : group.rows.map((row) => {
                        const key = sessionKey(row)
                        if (!row.members?.length) {
                          return (
                            <Fragment key={key}>
                              {drag.spacer(lane, key)}
                              {item(row, 'card', undefined, { className: row.context ? 'opacity-50' : undefined })}
                            </Fragment>
                          )
                        }
                        const view = viewOf(row)
                        const nested = view.shown.length > 0
                        const leadActive = isActive(row)
                        return (
                          <Fragment key={key}>
                            {drag.spacer(lane, key)}
                            <TeamBlock
                              lead={row}
                              view={view}
                              boxProps={onTeamMove || custom ? drag.box(key) : {}}
                              spacer={(before) => drag.spacer(teamLane(key), before)}
                              onToggle={() => onConfigChange(toggleTeamExpanded(config, row))}
                              onSelectMember={(member) => onSelect?.(member, { meta: false, ctrl: false, alt: false })}
                              onConversations={onAgentConversations}
                              renderLead={(tray) =>
                                item(row, 'card', undefined, {
                                  className: cn(row.context && 'opacity-50', nested && !leadActive && 'hover:bg-transparent'),
                                  teamTray: tray,
                                })
                              }
                              renderMember={(member) => item(member, 'member', row)}
                            />
                          </Fragment>
                        )
                      })}
                  {groupDrag ? null : drag.spacer(lane, undefined)}
                </div>
              </Fragment>
            )
          })}
          {drag.spacer(GROUPS_LANE, undefined)}
          {custom ? (
            <NewGroupButton
              onClick={() => {
                const id = newCustomGroupId()
                setCustom(addCustomGroup(customGroups, 'New group', id))
                setEditingGroup(id)
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}

const GROUPS_LANE = 'groups'
const LIFTED = 'data-[drag-lifted]:bg-surface data-[drag-lifted]:shadow-lg data-[drag-lifted]:ring-1 data-[drag-lifted]:ring-border'

function laneOf(group: SessionGroup): string {
  return `group:${group.key}`
}

function groupDragKey(group: SessionGroup): string {
  return `group:${group.key}`
}

function teamLane(lead: string): string {
  return `team:${lead}`
}

function iconSrcOf(row: SessionRow | undefined, icons: Record<string, string> | undefined): string | undefined {
  const icon = row?.info.project?.icon
  return icon?.type === 'image' ? icons?.[icon.hash] : undefined
}

interface SessionRowItemProps {
  row: SessionRow
  variant?: 'card' | 'member'
  teamTray?: ReactNode
  tile?: boolean
  className?: string
  dragProps?: HTMLAttributes<HTMLElement>
  dropCue?: DragCue
  nameOf?: (key: string) => string
  active?: boolean
  actions?: ReactNode
  activeSubagentId?: string
  activeShellId?: string
  now?: number
  showTime?: boolean
  rootAttributes?: Record<`data-${string}`, string>
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
  teamTray,
  tile,
  className,
  dragProps,
  dropCue,
  nameOf,
  active,
  actions,
  activeSubagentId,
  activeShellId,
  now,
  showTime,
  rootAttributes,
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
      teamTray={teamTray}
      tile={tile}
      className={className}
      active={active === true}
      activeStepKey={active ? (activeShellId ?? activeSubagentId) : undefined}
      now={now}
      showTime={showTime}
      rootAttributes={rootAttributes}
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
  const badge = dropCue?.badge
  if (!dragProps && !dropCue?.zone && !badge) {
    return item
  }
  const zone = dropCue?.zone
  return (
    <div
      {...dragProps}
      title={zone === 'refused' ? dropCue?.message : undefined}
      className={cn(
        'rounded-md',
        LIFTED,
        zone === 'join' && 'bg-accent/10 ring-1 ring-accent',
        zone === 'refused' && 'ring-1 ring-danger/60',
        (badge?.join || badge?.message) && 'opacity-85',
      )}
    >
      {item}
      {badge ? (
        <span
          role="status"
          className={cn(
            'pointer-events-none absolute -top-2 right-2 z-10 max-w-[calc(100%-1rem)] truncate rounded-sm px-1.5 text-label leading-4 shadow-sm',
            badge.tone === 'danger' ? 'bg-danger text-white' : 'bg-accent text-accent-fg',
          )}
        >
          {badge.message ?? (badge.join ? `Join ${nameOf?.(badge.join) ?? 'team'}` : 'Leave team')}
        </span>
      ) : null}
      {zone === 'refused' && dropCue?.message ? (
        <div role="status" className="px-3 pb-1 text-label text-danger">
          {dropCue.message}
        </div>
      ) : null}
    </div>
  )
}

const TRAY_MAX = 4

// Auto draws the members `teamView` shows inside the team's card under the lead, and the rest as a tray on its first
// line: a face selects that member, the trailing `+N` or chevron expands the team. Expanded, the lead's `^ N` chip returns
// it to Auto. A leading count says how many members need a person.
function TeamBlock({
  lead,
  view,
  boxProps,
  spacer,
  onToggle,
  onSelectMember,
  onConversations,
  renderLead,
  renderMember,
}: {
  lead: SessionRow
  view: TeamView
  boxProps: HTMLAttributes<HTMLElement>
  spacer: (before: string | undefined) => ReactNode
  onToggle: () => void
  onSelectMember: (member: SessionRow) => void
  onConversations?: (member: SessionRow) => void
  renderLead: (tray?: ReactNode) => ReactNode
  renderMember: (member: SessionRow) => ReactNode
}) {
  const team = lead.info.agent?.name ?? 'team'
  const overflow = view.tray.length > TRAY_MAX
  const avatarsShown = view.tray.slice(0, overflow ? TRAY_MAX - 1 : TRAY_MAX)
  const summary = teamSummaryText(lead)
  const needs = teamSummary(lead).attention
  const members = view.tray.length ? (
    <>
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
                <AgentAvatar row={member} size={16} title="" />
              </button>
            }
          >
            <MemberCard member={member} onConversations={onConversations ? () => onConversations(member) : undefined} />
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
    </>
  ) : view.expanded ? (
    <button
      type="button"
      aria-expanded
      aria-label={`Show only active Team Members of ${team}`}
      title="Show only active Members"
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className="flex h-4 shrink-0 items-center gap-0.5 rounded-[4px] px-0.5 text-label text-fg-3 tabular-nums hover:bg-row-hover hover:text-fg-1"
    >
      <ChevronUp className="size-3" />
      {lead.members?.length ?? view.shown.length}
    </button>
  ) : undefined
  const tray =
    members || needs ? (
      <span title={summary} className="flex shrink-0 items-center gap-1">
        {needs ? (
          <span
            aria-label={summary}
            className="flex h-4 shrink-0 items-center rounded-full bg-warning-bg px-1.5 text-[0.75rem] leading-none text-warning tabular-nums"
          >
            {needs}
          </span>
        ) : null}
        {members}
      </span>
    ) : undefined
  const nested = view.shown.length > 0
  return (
    <div
      {...boxProps}
      data-slot="team"
      data-drag-team={sessionKey(lead)}
      data-expanded={view.expanded || undefined}
      className={cn('flex flex-col rounded-[8px]', nested && 'bg-row-nest', LIFTED)}
    >
      {renderLead(tray)}
      {nested ? (
        <div className="flex flex-col gap-1 p-1">
          {view.shown.map((member) => (
            <Fragment key={sessionKey(member)}>
              {spacer(sessionKey(member))}
              {renderMember(member)}
            </Fragment>
          ))}
          {spacer(undefined)}
        </div>
      ) : null}
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
      className="hidden size-5 shrink-0 group-focus-within:inline-flex group-hover:inline-flex"
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
