import type { ReactNode, SyntheticEvent } from 'react'
import type { SessionRow, Sharing } from '@workerdeck/protocol'
import { Button, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, cn } from '@workerdeck/ui'
import {
  BedDouble,
  Eraser,
  Globe,
  Lock,
  LogOut,
  MessageSquareText,
  MoreHorizontal,
  Smile,
  Pencil,
  RotateCcw,
  Trash2,
  Ungroup,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react'

export type CardAction =
  | { kind: 'rename' }
  | { kind: 'status' }
  | { kind: 'avatar' }
  | { kind: 'clear' }
  | { kind: 'sleep' }
  | { kind: 'close' }
  | { kind: 'adopt' }
  | { kind: 'join'; lead: SessionRow }
  | { kind: 'leave' }
  | { kind: 'sharing'; sharing: Sharing }
  | { kind: 'dissolve' }
  | { kind: 'restart' }
  | { kind: 'retire' }

// Leads first, then solo agents: anything top-level can take members.
export function teamLeads(rows: SessionRow[], hostId: string | undefined, exclude?: SessionRow): SessionRow[] {
  const self = exclude?.info.agent?.id
  const open = rows.filter(
    (other) =>
      other.hostId === hostId &&
      other.info.id !== exclude?.info.id &&
      other.info.agent !== undefined &&
      other.info.agent.lead === undefined &&
      other.info.agent.id !== self,
  )
  return [...open.filter((other) => other.info.agent?.leads), ...open.filter((other) => !other.info.agent?.leads)]
}

export function teamMembers(row: SessionRow, rows: SessionRow[]): SessionRow[] {
  const id = row.info.agent?.id
  return id === undefined ? [] : rows.filter((other) => other.hostId === row.hostId && other.info.agent?.lead === id)
}

export function SessionCardActions({
  row,
  rows,
  allowShared = true,
  onAction,
}: {
  row: SessionRow
  rows: SessionRow[]
  allowShared?: boolean
  onAction: (action: CardAction) => void
}) {
  const { info } = row
  const agent = info.agent
  const leads = agent?.lead === undefined && !agent?.leads ? teamLeads(rows, row.hostId, row) : []
  const canSleep = info.capabilities?.engineSleep && info.status === 'idle' && !info.engineAsleep

  return (
    // The card is one big select target and React events bubble out of portals, so the menu's clicks stop here.
    <span className="flex shrink-0 items-center" onClick={stop} onDoubleClick={stop}>
      {info.capabilities?.clearContext ? (
        <QuickAction
          label="Clear context"
          title="Clear the conversation - the session keeps running and the old conversation stays resumable"
          onClick={() => onAction({ kind: 'clear' })}
        >
          <Eraser className="size-3 text-fg-3" />
        </QuickAction>
      ) : null}
      {canSleep ? (
        <QuickAction
          label="Sleep session"
          title="Stop the engine process to free its memory - the session stays here and wakes on your next message"
          onClick={() => onAction({ kind: 'sleep' })}
        >
          <BedDouble className="size-3 text-fg-3" />
        </QuickAction>
      ) : null}
      <QuickAction
        label="Close session"
        title={agent ? 'End this session; the agent stays and can start a new conversation' : 'Close session'}
        onClick={() => onAction({ kind: 'close' })}
      >
        <Trash2 className="size-3 text-fg-3" />
      </QuickAction>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={agent ? 'Agent actions' : 'Session actions'}
              title={agent ? 'Agent actions' : 'Session actions'}
              className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            >
              <MoreHorizontal className="size-3.5 text-fg-3" />
            </Button>
          }
        />
        <MenuContent>
          {info.owner ? <div className="px-2 pt-1.5 pb-1 text-label text-fg-4">Owner: {info.owner}</div> : null}
          <Item icon={<Pencil />} onClick={() => onAction({ kind: 'rename' })}>
            {agent ? 'Rename agent' : 'Rename session'}
          </Item>
          <Item icon={<MessageSquareText />} onClick={() => onAction({ kind: 'status' })}>
            {row.info.statusLabel ? 'Change status' : 'Set status'}
          </Item>
          {agent?.avatar ? (
            <Item icon={<Smile />} onClick={() => onAction({ kind: 'avatar' })}>
              Change avatar
            </Item>
          ) : null}
          <MenuSeparator />
          {agent ? null : (
            <Item icon={<UserPlus />} onClick={() => onAction({ kind: 'adopt' })}>
              Make agent
            </Item>
          )}
          {leads.length ? (
            <>
              <div className="px-2 pt-1.5 pb-1 text-label text-fg-4">Add to team</div>
              {leads.map((lead) => (
                <Item key={lead.info.id} icon={<Users />} onClick={() => onAction({ kind: 'join', lead })}>
                  <span className="truncate">Join {lead.info.agent?.name}</span>
                </Item>
              ))}
            </>
          ) : null}
          {agent?.lead !== undefined ? (
            <Item icon={<LogOut />} onClick={() => onAction({ kind: 'leave' })}>
              Leave {agent.team ?? 'team'}
            </Item>
          ) : null}
          {agent?.leads ? (
            <Item icon={<Ungroup />} onClick={() => onAction({ kind: 'dissolve' })}>
              Dissolve team
            </Item>
          ) : null}
          {agent && agent.lead === undefined ? (
            agent.shared ? (
              <Item icon={<Lock />} onClick={() => onAction({ kind: 'sharing', sharing: 'private' })}>
                Make private
              </Item>
            ) : (
              <Item
                icon={<Globe />}
                disabled={!allowShared}
                title={allowShared ? 'Other owners see a card and can message it' : 'This gateway shares no agents'}
                onClick={() => onAction({ kind: 'sharing', sharing: 'shared' })}
              >
                Share with other owners
              </Item>
            )
          ) : null}
          {agent ? (
            <>
              <Item icon={<RotateCcw />} onClick={() => onAction({ kind: 'restart' })}>
                New conversation
              </Item>
              <MenuSeparator />
              <Item icon={<UserMinus />} destructive onClick={() => onAction({ kind: 'retire' })}>
                Retire agent…
              </Item>
            </>
          ) : null}
        </MenuContent>
      </Menu>
    </span>
  )
}

function stop(e: SyntheticEvent): void {
  e.stopPropagation()
}

function Item({
  icon,
  destructive,
  disabled,
  title,
  onClick,
  children,
}: {
  icon: ReactNode
  destructive?: boolean
  disabled?: boolean
  title?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <MenuItem destructive={destructive} disabled={disabled} title={title} onClick={onClick} className="[&_svg]:size-3.5 [&_svg]:shrink-0">
      <span className={cn('flex', destructive ? 'text-danger' : 'text-fg-3')}>{icon}</span>
      {children}
    </MenuItem>
  )
}

function QuickAction({ label, title, onClick, children }: { label: string; title: string; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={title}
      className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      onClick={() => onClick()}
    >
      {children}
    </Button>
  )
}
