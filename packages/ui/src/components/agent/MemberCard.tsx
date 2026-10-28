import { STATE_LABELS, sessionLabel } from '@workerdeck/protocol'
import type { SessionRow } from '@workerdeck/protocol'
import { AgentAvatar } from './AgentAvatar.tsx'
import { statusLine } from './SessionItem.tsx'
import { SessionStatusIcon } from './SessionStatusIcon.tsx'
import { formatRelativeTime, friendlyModel } from '../../lib/format.ts'
import { vendorTextClass } from './EngineIcon.tsx'

export function MemberCard({
  member,
  onConversations,
}: {
  member: SessionRow
  onConversations?: () => void
}) {
  const { info } = member
  const name = info.agent?.name ?? sessionLabel(info)
  const state = info.engineAsleep && member.state === 'idle' ? 'Asleep' : STATE_LABELS[member.state]
  const status = statusLine(info.statusLabel)
  const task = info.checklist?.find((item) => item.status === 'in_progress')?.text
  const model = info.modelName ?? friendlyModel(info.model)
  const notes = [
    member.unseen > 0 ? `${member.unseen} new message${member.unseen === 1 ? '' : 's'}` : undefined,
    info.pendingPermissionCount > 0 ? `${info.pendingPermissionCount} waiting for approval` : undefined,
  ].filter((note): note is string => note !== undefined)
  return (
    <div className="flex w-64 flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <AgentAvatar row={member} size={32} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-body-sm font-medium text-fg-1">{name}</span>
          <span className="flex items-center gap-1.5 text-label text-fg-3">
            <SessionStatusIcon row={member} className="size-3" />
            <span>{state}</span>
            <span className="text-fg-4">· {formatRelativeTime(info.lastActivityAt ?? info.createdAt)}</span>
          </span>
        </div>
      </div>
      {status || task ? (
        <div className="flex flex-col gap-1 rounded-md bg-bg px-2 py-1.5 text-label">
          {status ? <span className="line-clamp-2 text-fg-2">{status}</span> : null}
          {task ? <span className="line-clamp-2 text-fg-3">{task}</span> : null}
        </div>
      ) : null}
      {notes.length ? <span className="text-label text-info">{notes.join(' · ')}</span> : null}
      <div className="flex items-center justify-between text-label text-fg-4">
        {model ? <span className={vendorTextClass(info.engine ?? 'claude', info.model)}>{model}</span> : <span />}
        {onConversations ? (
          <button type="button" onClick={onConversations} className="underline-offset-2 hover:text-fg-1 hover:underline">
            Conversations
            {info.agent?.conversation !== undefined && info.agent.conversation > 1 ? ` (${info.agent.conversation})` : ''}
          </button>
        ) : (
          <span>Click to open</span>
        )}
      </div>
    </div>
  )
}
