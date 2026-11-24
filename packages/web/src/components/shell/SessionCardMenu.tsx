import { useEffect, useState, type ReactNode } from 'react'
import {
  NEW_CONVERSATION_HINT,
  canSleep,
  clearContextOffered,
  newConversationGate,
  type SessionRow,
  type Sharing,
} from '@workerdeck/protocol'
import { MenuItem, MenuSeparator, cn, type ConversationRecovery } from '@workerdeck/ui'
import {
  BedDouble,
  CircleOff,
  Globe,
  History,
  Lock,
  LogOut,
  MessageSquareText,
  Pause,
  Play,
  Smile,
  Pencil,
  RotateCcw,
  Send,
  Target,
  Trash2,
  Ungroup,
  X,
  UserPlus,
  Users,
} from 'lucide-react'

export type CardAction =
  | { kind: 'rename' }
  | { kind: 'status' }
  | { kind: 'set-goal' }
  | { kind: 'clear-goal' }
  | { kind: 'pause-goal'; paused: boolean }
  | { kind: 'avatar' }
  | { kind: 'sleep' }
  | { kind: 'close' }
  | { kind: 'make-agent' }
  | { kind: 'join'; lead: SessionRow }
  | { kind: 'leave' }
  | { kind: 'sharing'; sharing: Sharing }
  | { kind: 'dissolve' }
  | { kind: 'new-conversation' }
  | { kind: 'retry-start'; n: number }
  | { kind: 'undelivered'; send: boolean; n: number }
  | { kind: 'conversations' }
  | { kind: 'delete' }

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

// A card's context menu items (right click, or a touch long press), mounted only while the menu is open.
export function SessionCardMenu({
  row,
  rows,
  allowShared = true,
  loadRecovery,
  onAction,
}: {
  row: SessionRow
  rows: SessionRow[]
  allowShared?: boolean
  // The agent's own record, where this gateway lets the caller list agents: it carries a first message a crash may have kept.
  // Read when the menu opens: a failed start or an uncertain first message, for any session.
  loadRecovery?: () => Promise<ConversationRecovery | undefined>
  onAction: (action: CardAction) => void
}) {
  const { info } = row
  const agent = info.agent
  const leads = agent?.lead === undefined && !agent?.leads ? teamLeads(rows, row.hostId, row) : []
  const sleepable = canSleep(info)
  const gate = newConversationGate(info)
  const cuttable = clearContextOffered(info)
  const [recovery, setRecovery] = useState<ConversationRecovery>()
  const failed = recovery?.startFailed
  const uncertain = recovery?.uncertainPrompt
  const goals = info.capabilities?.goals
  const goal = info.goal

  // Once per opening: the menu mounts on open, and the host passes a fresh closure every render.
  const [load] = useState(() => loadRecovery)
  useEffect(() => {
    void load?.().then(setRecovery)
  }, [load])

  return (
    <>
      {info.owner ? <div className="px-2 pt-1.5 pb-1 text-label text-fg-4">Owner: {info.owner}</div> : null}
      <Item icon={<Pencil />} onClick={() => onAction({ kind: 'rename' })}>
        {agent ? 'Rename agent' : 'Rename session'}
      </Item>
      <Item icon={<MessageSquareText />} onClick={() => onAction({ kind: 'status' })}>
        {row.info.statusLabel ? 'Change status' : 'Set status'}
      </Item>
      {agent ? (
        <Item icon={<Smile />} onClick={() => onAction({ kind: 'avatar' })}>
          Change avatar
        </Item>
      ) : null}
      {goals ? (
        <>
          <MenuSeparator />
          <Item icon={<Target />} onClick={() => onAction({ kind: 'set-goal' })}>
            {goal ? 'Replace goal…' : 'Set goal…'}
          </Item>
          {goals.pause && (goal?.state === 'active' || goal?.state === 'paused') ? (
            <Item
              icon={goal.state === 'active' ? <Pause /> : <Play />}
              onClick={() => onAction({ kind: 'pause-goal', paused: goal.state === 'active' })}
            >
              {goal.state === 'active' ? 'Pause goal' : 'Resume goal'}
            </Item>
          ) : null}
          {goal ? (
            <Item icon={<CircleOff />} onClick={() => onAction({ kind: 'clear-goal' })}>
              Clear goal
            </Item>
          ) : null}
        </>
      ) : null}
      <MenuSeparator />
      {agent ? null : (
        <Item icon={<UserPlus />} onClick={() => onAction({ kind: 'make-agent' })}>
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
      <MenuSeparator />
      {cuttable ? (
        <>
          <Item
            icon={<RotateCcw />}
            disabled={!gate.enabled}
            title={gate.enabled ? NEW_CONVERSATION_HINT : gate.reason}
            onClick={() => onAction({ kind: 'new-conversation' })}
          >
            New conversation
          </Item>
        </>
      ) : null}
      {sleepable ? (
        <Item
          icon={<BedDouble />}
          title="Stop the engine process to free its memory - the session stays here and wakes on your next message"
          onClick={() => onAction({ kind: 'sleep' })}
        >
          Sleep
        </Item>
      ) : null}
      <Item icon={<History />} onClick={() => onAction({ kind: 'conversations' })}>
        Conversations…
      </Item>
      {failed ? (
        <Item icon={<RotateCcw />} title={failed.error} onClick={() => onAction({ kind: 'retry-start', n: failed.n })}>
          Retry start
        </Item>
      ) : null}
      {uncertain ? (
        <>
          <div className="max-w-64 truncate px-2 pt-1.5 pb-1 text-label text-fg-4" title={uncertain.text}>
            First message may not have arrived
          </div>
          <Item icon={<Send />} onClick={() => onAction({ kind: 'undelivered', send: true, n: uncertain.n })}>
            Send again
          </Item>
          <Item icon={<X />} onClick={() => onAction({ kind: 'undelivered', send: false, n: uncertain.n })}>
            Dismiss
          </Item>
        </>
      ) : null}
      <MenuSeparator />
      <Item icon={<Trash2 />} destructive onClick={() => onAction({ kind: agent ? 'delete' : 'close' })}>
        {agent ? 'Delete agent…' : 'Close session'}
      </Item>
    </>
  )
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
