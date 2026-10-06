import { Fragment, useEffect, useRef, useState } from 'react'
import { Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { projectLabel, projectName, projectSubpath, sessionLabel } from '@workerdeck/protocol'
import type { SessionRow, SessionState, SessionTask, StepDisplay, SubagentDisplay } from '@workerdeck/protocol'
import { AgentAvatar, avatarOf, type AgentAvatars } from './AgentAvatar.tsx'
import { ContextRing } from './ContextRing.tsx'
import { EngineIcon, vendorMarkClass, vendorTextClass } from './EngineIcon.tsx'
import { ProjectIcon } from './ProjectIcon.tsx'
import { SessionStatusIcon } from './SessionStatusIcon.tsx'
import { StepRow, sessionSteps } from './SessionSteps.tsx'
import type { Step } from './SessionSteps.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost, formatRelativeTime, friendlyModel } from '../../lib/format.ts'

export type SelectModifiers = { meta: boolean; ctrl: boolean; alt: boolean }

export interface SessionItemProps {
  row: SessionRow
  active?: boolean
  activeStepKey?: string
  showGateway?: boolean
  showProject?: boolean
  projectIcons?: Record<string, string>
  subagents?: SubagentDisplay
  shells?: StepDisplay
  tasks?: StepDisplay
  onSelect?: (modifiers: SelectModifiers) => void
  onSelectSubagent?: (toolUseId: string) => void
  onSelectTask?: (task: SessionTask) => void
  onStopTask?: (toolUseId: string) => void
  onSelectShell?: (shellId: string) => void
  onKillShell?: (shellId: string) => void
  onShellAgentWrite?: (shellId: string, enabled: boolean) => void
  now?: number
  onRename?: (title: string) => void
  renameOn?: 'doubleClick' | 'external'
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  actions?: ReactNode
  // Drawn when `row.info.agent` is set: the card then leads with the avatar and names the agent.
  avatars?: AgentAvatars
  // `member` is the one-row card a team draws under its lead.
  variant?: 'card' | 'member'
  // The state the avatar badge draws, for a folded lead standing in for its team.
  badgeState?: SessionState
  // Unread summed over a folded team's members, drawn with the team glyph beside the lead's own.
  teamUnseen?: number
  // Draws a session with no agent in the agent card's shape (an engine-mark tile for the avatar), so a list mixing
  // agents and plain sessions keeps one column.
  tile?: boolean
  className?: string
}

const NO_MODIFIERS: SelectModifiers = { meta: false, ctrl: false, alt: false }

export function SessionItem({
  row,
  active = false,
  activeStepKey,
  showGateway,
  showProject = true,
  projectIcons,
  subagents = 'active',
  shells = 'active',
  tasks = 'active',
  onSelect,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
  now,
  onRename,
  renameOn = 'doubleClick',
  editing,
  onEditingChange,
  actions,
  avatars,
  variant = 'card',
  badgeState,
  teamUnseen = 0,
  tile = false,
  className,
}: SessionItemProps) {
  const { info } = row
  const [ownEditing, setOwnEditing] = useState(false)
  const isEditing = editing ?? ownEditing
  const setEditing = (next: boolean) => {
    setOwnEditing(next)
    onEditingChange?.(next)
  }

  const engine = info.engine ?? 'claude'
  const project = showProject ? projectLabel(row) : projectSubpath(row)
  const projectTitle = showProject ? projectName(row) : undefined
  const projectIcon = showProject ? info.project?.icon : undefined
  const iconSrc = projectIcon?.type === 'image' ? projectIcons?.[projectIcon.hash] : undefined
  const cost = formatCost(info.costUsd ?? info.totalCostUsd)
  const extras = [
    showGateway ? row.hostName : undefined,
    info.profile ? `@${info.profile}` : undefined,
    cost === '-' ? undefined : cost,
  ].filter((part): part is string => Boolean(part))

  const model = friendlyModel(info.model)
  const parts: ReactNode[] = []
  if (model) {
    parts.push(
      <span key="model" className={vendorTextClass(engine, info.model)}>
        {model}
      </span>,
    )
  }
  if (project !== undefined) {
    parts.push(
      <span key="project" title={projectTitle}>
        <ProjectIcon icon={projectIcon} src={iconSrc} name={projectTitle} className="mr-1.5 size-4 align-[-0.3em]" />
        {project}
      </span>,
    )
  }
  for (const extra of extras) {
    parts.push(<span key={extra}>{extra}</span>)
  }
  const steps = sessionSteps(
    info,
    (toolUseId) => (onSelectSubagent ? onSelectSubagent(toolUseId) : onSelect?.(NO_MODIFIERS)),
    subagents,
    {
      now: now ?? Date.now(),
      show: shells,
      onSelect: (shellId) => (onSelectShell ? onSelectShell(shellId) : onSelect?.(NO_MODIFIERS)),
      onKill: onKillShell,
      onAgentWrite: onShellAgentWrite,
    },
    {
      show: tasks,
      live: info.status === 'running' || info.status === 'starting' || info.status === 'awaiting_approval',
      onSelect: (task) => (onSelectTask ? onSelectTask(task) : onSelect?.(NO_MODIFIERS)),
      onStop: onStopTask,
    },
  )
  const holdsOpenStep = steps.some((s) => s.key === activeStepKey)
  const agent = info.agent
  const label = agent ? agent.name : sessionLabel(info)
  const editable = agent ? agent.name : (info.title ?? '')
  const time = formatRelativeTime(info.lastActivityAt ?? info.createdAt)
  const nameLabel =
    isEditing && onRename ? (
      <NameEditor
        initial={editable}
        placeholder={agent ? 'Agent name' : 'Session name'}
        onCommit={(title) => {
          setEditing(false)
          if (title !== editable && (title || !agent)) {
            onRename(title)
          }
        }}
        onCancel={() => setEditing(false)}
      />
    ) : (
      <span
        onDoubleClick={
          onRename && renameOn === 'doubleClick'
            ? (e) => {
                e.stopPropagation()
                setEditing(true)
              }
            : undefined
        }
        className="min-w-0 shrink truncate text-body-sm font-medium tracking-[-0.005em] text-fg-1"
      >
        {label}
      </span>
    )
  const unread =
    row.unseen > 0 ? (
      <span
        // Prose, not rows: `unseen` counts messages a person has not read (`proseCount`).
        title={`${row.unseen} new message${row.unseen === 1 ? '' : 's'}`}
        className={cn(
          'flex h-4 min-w-6 shrink-0 items-center justify-center rounded-full px-2',
          'text-[0.75rem] leading-none tracking-[-0.005em] tabular-nums',
          // Grey while the turn is still producing, accent once it has stopped: the badge's colour
          // answers "is this waiting for me", and a working session is not yet.
          row.state === 'working' ? 'bg-badge text-badge-fg' : 'bg-accent text-accent-fg',
        )}
      >
        {row.unseen}
      </span>
    ) : null

  return (
    <div
      data-slot="session-item"
      data-active={active || undefined}
      data-asleep={info.engineAsleep || undefined}
      title={info.engineAsleep ? 'Asleep, wakes on your next message' : undefined}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (e.detail > 1 || isEditing) {
          return
        }
        onSelect?.({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey })
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) {
          return
        }
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.({ meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey })
        }
      }}
      className={cn(
        'group flex w-full cursor-pointer flex-col p-1 text-left outline-none',
        'rounded-[4px] transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        holdsOpenStep ? 'bg-row-selected-weak' : active ? 'bg-row-selected' : 'hover:bg-row-hover',
        className,
      )}
    >
      {agent && variant === 'member' ? (
        <div className={cn('flex h-6 items-center gap-1.5 overflow-hidden py-0.5 pr-0.5 pl-1.5', info.engineAsleep && 'opacity-60')}>
          <AgentAvatar row={row} image={avatarOf(avatars, agent)} size={22} />
          {nameLabel}
          {info.title ? <span className="min-w-0 flex-1 truncate text-body-sm text-fg-3">{info.title}</span> : <span className="flex-1" />}
          {unread}
          <span className="shrink-0 text-body-sm text-fg-4">{time}</span>
          {actions}
        </div>
      ) : agent || tile ? (
        <div className={cn('flex items-center gap-2 py-0.5 pr-0.5 pl-1.5', info.engineAsleep && 'opacity-60')}>
          <AgentAvatar row={row} image={avatarOf(avatars, agent)} state={badgeState} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex h-5 items-center gap-1.5 overflow-hidden">
              {nameLabel}
              {agent?.leads ? (
                <span className="shrink-0 rounded-[3px] border border-accent/50 px-1 text-[0.625rem] leading-3.5 font-medium tracking-wide text-accent">
                  LEAD
                </span>
              ) : null}
              <span className="flex-1" />
              {unread}
              {teamUnseen > 0 ? (
                <span
                  title={`${teamUnseen} new message${teamUnseen === 1 ? '' : 's'} in the team`}
                  className="flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-accent px-1.5 text-[0.75rem] leading-none text-accent-fg tabular-nums"
                >
                  <Users className="size-3" />
                  {teamUnseen}
                </span>
              ) : null}
              <ContextRing usage={info.contextUsage} engine={engine} size={16} className="p-0.5" />
            </div>
            <div className="flex h-5 items-center gap-1.5 overflow-hidden text-body-sm tracking-[-0.005em]">
              {agent ? (
                <>
                  {info.title ? <span className="min-w-0 truncate text-fg-4">{info.title}</span> : null}
                  <span className="shrink-0 text-fg-4">
                    {model ? (
                      <>
                        {info.title ? '· ' : ''}
                        <span className={vendorTextClass(engine, info.model)}>{model}</span>
                        {' · '}
                      </>
                    ) : info.title ? (
                      '· '
                    ) : null}
                    {time}
                  </span>
                </>
              ) : (
                <>
                  <span className="min-w-0 truncate text-fg-4">
                    {parts.map((part, i) => (
                      <Fragment key={i}>
                        {i > 0 ? ' · ' : ''}
                        {part}
                      </Fragment>
                    ))}
                  </span>
                  <span className="shrink-0 text-fg-4">
                    {parts.length > 0 ? '· ' : ''}
                    {time}
                  </span>
                </>
              )}
              <span className="min-w-0 flex-1" />
              {actions}
            </div>
          </div>
        </div>
      ) : (
        <div className={cn('flex flex-col gap-1 py-0.5 pr-0.5 pl-1.5', info.engineAsleep && 'opacity-60')}>
          <div className="flex h-5 items-center gap-1.5 overflow-hidden">
            <Gutter>
              <SessionStatusIcon row={row} />
            </Gutter>
            {nameLabel}
            <span className="flex-1" />
            {unread}
            <ContextRing usage={info.contextUsage} engine={engine} size={16} className="p-0.5" />
          </div>

          <div className="flex h-5 items-center gap-1.5 overflow-hidden text-body-sm tracking-[-0.005em]">
            <Gutter>
              <EngineIcon engine={engine} model={info.model} className={cn('size-4', vendorMarkClass(engine, info.model))} />
            </Gutter>
            <span className="min-w-0 truncate text-fg-4">
              {parts.map((part, i) => (
                <Fragment key={i}>
                  {i > 0 ? ' · ' : ''}
                  {part}
                </Fragment>
              ))}
            </span>
            <span className="shrink-0 text-fg-4">
              {parts.length > 0 ? '· ' : ''}
              {time}
            </span>
            <span className="min-w-0 flex-1" />
            {actions}
          </div>
        </div>
      )}

      {steps.length > 0 ? (
        <div className="flex flex-col">
          {steps.map((step: Step) => (
            <StepRow key={step.key} step={step} active={step.key === activeStepKey} onSelect={step.onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Gutter({ children }: { children: ReactNode }) {
  return <span className="flex size-4 shrink-0 items-center justify-center">{children}</span>
}

function NameEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string
  placeholder: string
  onCommit: (title: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  useEffect(() => {
    const onWindowFocus = () => {
      ref.current?.focus()
      ref.current?.select()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [])
  return (
    <input
      ref={ref}
      value={value}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={placeholder}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        // Guarded on `document.hasFocus()`: selecting a session focuses another surface (in the extension, another view), and an unguarded blur closes the editor in the frame it appeared.
        if (document.hasFocus()) {
          onCommit(value.trim())
        }
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          onCommit(value.trim())
        } else if (e.key === 'Escape') {
          onCancel()
        }
      }}
      className={cn(
        '-my-0.5 min-w-0 flex-1 rounded-sm border border-ring bg-bg px-1 py-px',
        'text-body-sm leading-5 text-fg-1 outline-none',
      )}
    />
  )
}
