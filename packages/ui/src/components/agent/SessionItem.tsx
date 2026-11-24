import { useEffect, useRef, useState } from 'react'
import { CircleX, Globe, Hand, Pin, ShieldAlert, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import {
  ATTENTION_LABELS,
  GOAL_HOLDS_ENGINE_HINT,
  attentionOf,
  attentionTitle,
  cardStatus,
  listState,
  goalHoldsEngine,
  projectLabel,
  projectSubpath,
  sessionLabel,
} from '@workerdeck/protocol'
import type { FoldableStepKind, SessionInfo, SessionRow, SessionState, SessionTask } from '@workerdeck/protocol'
import { AgentAvatar } from './AgentAvatar.tsx'
import { ModelBadge } from './EngineIcon.tsx'
import { StepChips, StepRow, sessionSteps } from './SessionSteps.tsx'
import type { Step } from './SessionSteps.tsx'
import { cn } from '../../lib/utils.ts'
import { formatRelativeTime, friendlyModel } from '../../lib/format.ts'

const SHARED_TITLE = 'Shared with other owners'

export type SelectModifiers = { meta: boolean; ctrl: boolean; alt: boolean }

export interface SessionItemProps {
  row: SessionRow
  active?: boolean
  activeStepKey?: string
  showGateway?: boolean
  showProject?: boolean
  // Step rows fold into one chip per kind unless the kind is listed here; without `onToggleSteps` the card keeps its own.
  expandedSteps?: readonly FoldableStepKind[]
  onToggleSteps?: (kind: FoldableStepKind) => void
  onSelect?: (modifiers: SelectModifiers) => void
  onSelectSubagent?: (toolUseId: string) => void
  onSelectTask?: (task: SessionTask) => void
  onStopTask?: (toolUseId: string) => void
  onSelectShell?: (shellId: string) => void
  onKillShell?: (shellId: string) => void
  onShellAgentWrite?: (shellId: string, enabled: boolean) => void
  now?: number
  showTime?: boolean
  rootAttributes?: Record<`data-${string}`, string>
  onRename?: (title: string) => void
  renameOn?: 'doubleClick' | 'external'
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  actions?: ReactNode
  // `member` is the one-row card a team draws under its lead.
  variant?: 'card' | 'member'
  // The state the avatar badge draws, for a folded lead standing in for its team.
  badgeState?: SessionState
  // Unread summed over a folded team's members, drawn with the team glyph beside the lead's own.
  teamUnseen?: number
  // A folded lead's members, drawn on its first line before the context ring.
  teamTray?: ReactNode
  // A member's pin keeps it drawn while its team is in Auto. The button shows on hover, stays when pinned, and gives way
  // to a reason chip.
  pinned?: boolean
  onTogglePin?: () => void
  className?: string
}

const NO_MODIFIERS: SelectModifiers = { meta: false, ctrl: false, alt: false }

export function SessionItem({
  row,
  active = false,
  activeStepKey,
  showGateway,
  showProject = true,
  expandedSteps,
  onToggleSteps,
  onSelect,
  onSelectSubagent,
  onSelectTask,
  onStopTask,
  onSelectShell,
  onKillShell,
  onShellAgentWrite,
  now,
  showTime = true,
  rootAttributes,
  onRename,
  renameOn = 'doubleClick',
  editing,
  onEditingChange,
  actions,
  variant = 'card',
  badgeState,
  teamUnseen = 0,
  teamTray,
  pinned = false,
  onTogglePin,
  className,
}: SessionItemProps) {
  const { info } = row
  const [ownEditing, setOwnEditing] = useState(false)
  const [ownExpanded, setOwnExpanded] = useState<FoldableStepKind[]>([])
  const expanded = onToggleSteps ? (expandedSteps ?? []) : ownExpanded
  const toggleSteps =
    onToggleSteps ??
    ((kind: FoldableStepKind) => setOwnExpanded((held) => (held.includes(kind) ? held.filter((k) => k !== kind) : [...held, kind])))
  const isEditing = editing ?? ownEditing
  const setEditing = (next: boolean) => {
    setOwnEditing(next)
    onEditingChange?.(next)
  }

  const engine = info.engine ?? 'claude'
  const project = showProject ? projectLabel(row) : projectSubpath(row)
  const model = info.modelName ?? friendlyModel(info.model)
  const status = statusLine(info.statusLabel)
  // Only its own reason to need a person: a member that needs one is always listed under its lead, so the lead stays plain.
  const needsYou = listState(row) === 'attention'
  const reasons = <ReasonChips info={info} />
  // Plain text in the reasons' slot, on a sub-agent only (a top-level agent is always relevant), and only once the turn
  // has stopped: a reason already says act, and a count still being produced is not waiting for anyone yet.
  const unreadCount =
    variant === 'member' && row.unseen > 0 && row.state !== 'working' ? (
      <span
        title={`${row.unseen} new message${row.unseen === 1 ? '' : 's'}`}
        className="flex h-4 min-w-4 shrink-0 items-center justify-center text-label font-semibold text-accent tabular-nums"
      >
        {row.unseen > 99 ? '99+' : row.unseen}
      </span>
    ) : null
  // Nothing here for a person right now: the face greys out so the cards that do want attention stand out.
  const shownState = badgeState ?? row.teamState ?? row.state
  const quiet = !active && !needsYou && row.unseen === 0 && (shownState === 'idle' || shownState === 'ended')
  const quietAvatar = quiet && 'opacity-50 grayscale'
  const steps = sessionSteps(
    info,
    (toolUseId) => (onSelectSubagent ? onSelectSubagent(toolUseId) : onSelect?.(NO_MODIFIERS)),
    {
      now: now ?? Date.now(),
      onSelect: (shellId) => (onSelectShell ? onSelectShell(shellId) : onSelect?.(NO_MODIFIERS)),
      onKill: onKillShell,
      onAgentWrite: onShellAgentWrite,
    },
    {
      live: info.status === 'running' || info.status === 'starting' || info.status === 'awaiting_approval',
      onSelect: (task) => (onSelectTask ? onSelectTask(task) : onSelect?.(NO_MODIFIERS)),
      onStop: onStopTask,
    },
  )
  const holdsOpenStep = steps.some((s) => s.key === activeStepKey)
  const shown = steps.filter((step) => expanded.includes(step.fold))
  const chips = <StepChips steps={steps} expanded={expanded} activeStepKey={activeStepKey} onToggle={toggleSteps} />
  const agent = info.agent
  const line = agent ? cardStatus(info, row.state) : undefined
  const lineTone = line?.source === 'label' || line?.source === 'goal' ? 'text-fg-3' : 'text-fg-4'
  const lineTitle = line?.source === 'goal' && goalHoldsEngine(info) ? `${line.text}\n${GOAL_HOLDS_ENGINE_HINT}` : line?.text
  const label = agent ? agent.name : sessionLabel(info)
  const editable = agent ? agent.name : (info.title ?? '')
  const time = showTime && !agent ? formatRelativeTime(info.lastActivityAt ?? info.createdAt) : undefined
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
        title={agent ? agentTitle(info) : undefined}
        className={cn(
          'text-body-sm font-medium tracking-[-0.005em]',
          agent ? 'shrink-0 whitespace-nowrap' : 'min-w-0 truncate',
          active || !agent ? 'text-fg-1' : 'text-fg-name',
        )}
      >
        {label}
      </span>
    )
  return (
    <div
      {...rootAttributes}
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
        'group group/session flex w-full cursor-pointer flex-col p-1 text-left outline-none',
        'rounded-[6px]',
        'transition-colors focus-visible:ring-2',
        needsYou
          ? cn('bg-row-attention focus-visible:ring-warning', active && 'ring-1 ring-warning ring-inset')
          : cn('focus-visible:ring-ring', holdsOpenStep ? 'bg-row-selected-weak' : active ? 'bg-row-selected' : 'hover:bg-row-hover'),
        className,
      )}
    >
      <div className="flex h-7 items-center gap-2">
        <AgentAvatar
          row={row}
          size={28}
          {...(variant === 'member' ? {} : { state: badgeState, context: true })}
          className={cn(quietAvatar)}
        />
        <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden', info.engineAsleep && 'opacity-60')}>
          {nameLabel}
          {model ? <ModelBadge engine={engine} model={info.model} name={model} className="text-label" /> : null}
          {agent?.shared ? (
            <span title={SHARED_TITLE} aria-label={SHARED_TITLE} className="flex shrink-0 text-fg-4">
              <Globe className="size-3" />
            </span>
          ) : null}
          {isEditing ? null : line ? (
            <span title={lineTitle} className={cn('min-w-0 truncate text-label tracking-[-0.005em]', lineTone)}>
              {line.text}
            </span>
          ) : agent ? null : (
            <span className="min-w-0 shrink-[999] truncate text-label tracking-[-0.005em] text-fg-4">
              {[status, project, showGateway ? row.hostName : undefined, time].filter(Boolean).join(' · ')}
            </span>
          )}
          {isEditing ? null : <span className="flex-1" />}
          {chips}
          {attentionOf(info).reasons.length > 0 ? reasons : unreadCount}
          {onTogglePin && attentionOf(info).reasons.length === 0 ? <PinButton name={label} pinned={pinned} onToggle={onTogglePin} /> : null}
          {teamUnseen > 0 ? (
            <span
              title={`${teamUnseen} new message${teamUnseen === 1 ? '' : 's'} in the team`}
              className="flex h-4 shrink-0 items-center gap-0.5 rounded-full bg-accent px-1.5 text-[0.75rem] leading-none text-accent-fg tabular-nums"
            >
              <Users className="size-3" />
              {teamUnseen}
            </span>
          ) : null}
          {teamTray}
          {actions}
        </div>
      </div>

      {shown.length > 0 ? (
        <div className="flex flex-col">
          {shown.map((step: Step) => (
            <StepRow key={step.key} step={step} active={step.key === activeStepKey} onSelect={step.onSelect} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function PinButton({ name, pinned, onToggle }: { name: string; pinned: boolean; onToggle: () => void }) {
  const title = pinned ? 'Unpin' : 'Pin: keep visible when the team is collapsed'
  return (
    <button
      type="button"
      aria-pressed={pinned}
      aria-label={pinned ? `Unpin ${name}` : `Pin ${name}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        'size-4 shrink-0 items-center justify-center rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pinned
          ? 'flex text-fg-3 hover:text-fg-1'
          : 'hidden text-fg-4 group-focus-within/session:flex group-hover/session:flex hover:text-fg-1',
      )}
    >
      <Pin className="size-3" fill={pinned ? 'currentColor' : 'none'} />
    </button>
  )
}

const REASON_ICONS = { approval: ShieldAlert, blocked: Hand, failed: CircleX } as const

function ReasonChips({ info }: { info: SessionInfo }) {
  return attentionOf(info).reasons.map((reason) => {
    const Icon = REASON_ICONS[reason]
    return (
      <span
        key={reason}
        role="img"
        title={attentionTitle(reason, info)}
        aria-label={ATTENTION_LABELS[reason]}
        className={cn('flex size-4 shrink-0 items-center justify-center', reason === 'failed' ? 'text-danger' : 'text-warning')}
      >
        <Icon className="size-3.5" />
      </span>
    )
  })
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

export function statusLine(label: SessionInfo['statusLabel']): string | undefined {
  return label?.text
}

function agentTitle(info: SessionInfo): string {
  const parts = [info.agent?.name ?? '']
  if (info.owner) {
    parts.push(`owner ${info.owner}`)
  }
  if (info.agent?.shared) {
    parts.push(SHARED_TITLE.toLowerCase())
  }
  return parts.join(' · ')
}
