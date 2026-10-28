import { useId } from 'react'
import type { SessionRow, SessionState } from '@workerdeck/protocol'
import { EngineIcon, vendorMarkClass } from './EngineIcon.tsx'
import { SessionStatusIcon } from './SessionStatusIcon.tsx'
import { CONTEXT_WRAP_UP_DEFAULT, faceProjectOf, faceStateOf, faceSvg } from '../../lib/face-svg.ts'
import { cn } from '../../lib/utils.ts'

export interface AgentAvatarProps {
  row: SessionRow
  size?: number
  // The state the face draws; a folded lead passes its team's most urgent one.
  state?: SessionState
  // Fills the backdrop to the session's context use, amber from `wrapUp` on.
  context?: boolean
  wrapUp?: number
  badge?: boolean
  title?: string
  className?: string
}

export function AgentAvatar({ row, size = 32, state, context = false, wrapUp = CONTEXT_WRAP_UP_DEFAULT, badge = true, title, className }: AgentAvatarProps) {
  const { info } = row
  const id = `wdf${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const agent = info.agent
  if (!agent) {
    return <EngineTile row={row} size={size} state={state} badge={badge} title={title} className={className} />
  }
  const usage = context ? info.contextUsage : undefined
  const markup = faceSvg({
    face: agent.face,
    project: faceProjectOf(info),
    state: faceStateOf(row, state),
    size,
    id,
    phase: agent.id,
    ...(usage ? { context: usage.percentage / 100, threshold: wrapUp } : {}),
  })
  const reading = usage ? `Context ${usage.percentage.toFixed(0)}%` : undefined
  return (
    <span
      data-slot="agent-avatar"
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
      title={title ?? [agent.name, reading].filter(Boolean).join(' · ')}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

// A plain session drawn in the agent card's shape: its engine's mark, with the status badge a face would otherwise carry.
function EngineTile({ row, size, state, badge, title, className }: Required<Pick<AgentAvatarProps, 'row' | 'size' | 'badge'>> & AgentAvatarProps) {
  const { info } = row
  const shown = state ?? row.state
  const engine = info.engine ?? 'claude'
  const badgeSize = size >= 28 ? 14 : 11
  return (
    <span data-slot="agent-avatar" className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }} title={title}>
      <span className="flex size-full items-center justify-center rounded-[4px] border border-dashed border-border">
        <EngineIcon engine={engine} model={info.model} className={cn('size-1/2', vendorMarkClass(engine, info.model))} />
      </span>
      {badge && (shown !== 'idle' || info.engineAsleep) ? (
        <span className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-bg" style={{ width: badgeSize, height: badgeSize }}>
          <SessionStatusIcon row={{ ...row, state: shown }} className="size-full p-px" />
        </span>
      ) : null}
    </span>
  )
}

export function LeadChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-[3px] border border-accent/50 px-1 text-[0.625rem] leading-3.5 font-medium tracking-wide text-accent',
        className,
      )}
    >
      LEAD
    </span>
  )
}

export interface AgentHeadingProps {
  row: SessionRow
  // Overrides `AgentRef.conversation`, which a gateway sends from the second conversation on.
  conversation?: number
  className?: string
}

// A session panel's title for an agent: avatar, name, its place in a team. Plain sessions keep the host's own title.
export function AgentHeading({ row, conversation, className }: AgentHeadingProps) {
  const agent = row.info.agent
  if (!agent) {
    return null
  }
  const n = conversation ?? agent.conversation ?? 1
  const detail = [agent.lead !== undefined && agent.team ? `${agent.team} team` : undefined, `conversation ${n}`]
    .filter(Boolean)
    .join(' · ')
  return (
    <span data-slot="agent-heading" className={cn('flex min-w-0 items-center gap-2', className)}>
      <AgentAvatar row={row} size={20} />
      <span className="truncate text-body-sm font-medium text-fg-1">{agent.name}</span>
      {agent.leads ? <LeadChip /> : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
    </span>
  )
}
