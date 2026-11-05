import type { Runner } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import { absentStatus, recordInfo } from '../services/record-info.ts'
import type { StoredSessionRecord } from '../services/session-store.ts'

export type ResolvedSession = { runner: Runner | undefined; parked: StoredSessionRecord | null; info: SessionInfo }

export async function sessionInfoOf(ctx: ServerContext, id: string): Promise<SessionInfo | undefined> {
  const live = ctx.registry.get(id)?.info()
  if (live) {
    return live
  }
  const stored = await ctx.parking.get(id)
  return stored ? stored.info : await endedInfo(ctx, id)
}

// Missing and not-visible answer the same 404: whether a session exists outside the caller's scope is not its business.
export async function resolveSession(ctx: ServerContext, id: string, auth: AuthContext): Promise<ResolvedSession> {
  const runner = ctx.registry.get(id)
  const parked = runner ? null : await ctx.parking.get(id)
  const info = runner?.info() ?? parked?.info ?? (await endedInfo(ctx, id))
  if (!info || !ctx.auth.canSee(auth, info) || ctx.agents.tombstone(id)) {
    fail(404, 'session not found')
  }
  return { runner, parked, info }
}

// A record without a runtime is listed by `absentStatus`. Closed records only on request.
export async function listSessions(ctx: ServerContext, closed: boolean): Promise<SessionInfo[]> {
  const sessions = [...ctx.registry.list(), ...(await ctx.parking.listInfo())].filter((info) => !ctx.agents.tombstone(info.id))
  const shown = new Set(sessions.map((info) => info.id))
  for (const record of await ctx.records.list()) {
    if (shown.has(record.id) || ctx.registry.get(record.id) || (record.closedAt === undefined && ctx.agents.tombstone(record.id))) {
      continue
    }
    if (record.closedAt !== undefined) {
      if (closed) {
        sessions.push(recordInfo(ctx, record, 'closed'))
      }
      continue
    }
    if (record.runtime === undefined) {
      sessions.push(recordInfo(ctx, record, absentStatus(record)))
    }
  }
  return sessions
}

async function endedInfo(ctx: ServerContext, id: string): Promise<SessionInfo | undefined> {
  const record = await ctx.records.get(id)
  if (!record || record.closedAt !== undefined || record.runtime !== undefined || ctx.registry.get(id)) {
    return undefined
  }
  return recordInfo(ctx, record, absentStatus(record))
}

export function requireLive(runner: Runner | undefined, why: string): Runner {
  if (!runner) {
    fail(409, `session is parked (${why})`)
  }
  return runner
}
