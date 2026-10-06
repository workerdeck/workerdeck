import type { CSSProperties } from 'react'
import type { AgentRef, SessionRow, SessionState } from '@workerdeck/protocol'
import { EngineIcon, vendorMarkClass } from './EngineIcon.tsx'
import { SessionStatusIcon } from './SessionStatusIcon.tsx'
import { cn } from '../../lib/utils.ts'

export type AgentAvatarImage = { still: string; busy?: { src: string; durations: number[] } }

// Keyed by `AgentRef.avatar`, the gateway path: the host fetches with its own credentials and hands over data URLs.
export type AgentAvatars = Record<string, AgentAvatarImage>

export function avatarOf(avatars: AgentAvatars | undefined, agent: AgentRef | undefined): AgentAvatarImage | undefined {
  return agent?.avatar === undefined ? undefined : avatars?.[agent.avatar]
}

export interface AgentAvatarProps {
  row: SessionRow
  image?: AgentAvatarImage
  size?: number
  // The state the corner badge draws; a folded lead passes its team's most urgent one.
  state?: SessionState
  badge?: boolean
  className?: string
}

export function AgentAvatar({ row, image, size = 32, state, badge = true, className }: AgentAvatarProps) {
  const { info } = row
  const shown = state ?? row.state
  const busy = shown === 'working' && image?.busy && image.busy.durations.length > 1 ? image.busy : undefined
  const asleep = info.engineAsleep === true
  const engine = info.engine ?? 'claude'
  const badgeSize = size >= 28 ? 14 : 11
  return (
    <span
      data-slot="agent-avatar"
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
      title={info.agent?.name}
    >
      {busy ? (
        <span
          aria-hidden
          className="wd-avatar-strip size-full rounded-[4px]"
          style={
            {
              backgroundImage: `url(${busy.src})`,
              backgroundSize: `${busy.durations.length * size}px ${size}px`,
              '--wd-strip-end': `-${busy.durations.length * size}px`,
              '--wd-strip-steps': busy.durations.length,
              animationDuration: `${busy.durations.reduce((sum, ms) => sum + ms, 0)}ms`,
            } as CSSProperties
          }
        />
      ) : image ? (
        <img
          src={image.still}
          alt=""
          draggable={false}
          className={cn('size-full rounded-[4px] [image-rendering:pixelated]', asleep && 'opacity-60 grayscale')}
        />
      ) : (
        <span className="flex size-full items-center justify-center rounded-[4px] border border-dashed border-border">
          <EngineIcon engine={engine} model={info.model} className={cn('size-1/2', vendorMarkClass(engine, info.model))} />
        </span>
      )}
      {badge && (shown !== 'idle' || asleep) ? (
        <span
          className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-bg"
          style={{ width: badgeSize, height: badgeSize }}
        >
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
  image?: AgentAvatarImage
  // Overrides `AgentRef.conversation`, which a gateway sends from the second conversation on.
  conversation?: number
  className?: string
}

// A session panel's title for an agent: avatar, name, its place in a team. Plain sessions keep the host's own title.
export function AgentHeading({ row, image, conversation, className }: AgentHeadingProps) {
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
      <AgentAvatar row={row} image={image} size={24} />
      <span className="truncate text-body-sm font-medium text-fg-1">{agent.name}</span>
      {agent.leads ? <LeadChip /> : null}
      {detail ? <span className="shrink-0 text-label text-fg-4">{detail}</span> : null}
    </span>
  )
}
