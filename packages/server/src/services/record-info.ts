import type { SessionInfo, SessionStatus } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { SessionRecord } from './session-records.ts'

// Runtime absent is not a status: a record with neither runner nor runtime is `starting` while its first start is
// still owed (recovery starts it), else `failed` (it ran and left nothing to wake).
export function absentStatus(record: SessionRecord): SessionStatus {
  return record.cut?.from === 0 && record.startFailed === undefined ? 'starting' : 'failed'
}

export function recordInfo(ctx: ServerContext, record: SessionRecord, status: SessionStatus): SessionInfo {
  const config = record.running ?? record.requested
  const last = record.conversations.at(-1)
  const profile = config?.profile ?? last?.profile
  const known = profile === undefined ? undefined : ctx.profiles.get(profile)
  return {
    id: record.id,
    status,
    cwd: config?.cwd ?? last?.cwd ?? '',
    ...(profile ? { profile } : {}),
    engine: known ? engineOf(known) : (last?.engine ?? 'claude'),
    ...(config?.model ? { model: config.model } : {}),
    createdAt: record.createdAt,
    lastSeq: 0,
    conversation: record.conversation,
    pendingPermissionCount: 0,
    ...(record.owner ? { owner: record.owner } : {}),
    ...(record.scope ? { scope: record.scope } : {}),
    ...(last?.title ? { title: last.title } : {}),
  }
}
