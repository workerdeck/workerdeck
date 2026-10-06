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
