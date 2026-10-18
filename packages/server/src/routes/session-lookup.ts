import type { Runner } from '@workerdeck/core'
import type { SessionInfo } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import { isArchived, type StoredSessionRecord } from '../services/session-store.ts'

export type ResolvedSession = { runner: Runner | undefined; parked: StoredSessionRecord | null; info: SessionInfo }

export async function sessionInfoOf(ctx: ServerContext, id: string): Promise<SessionInfo | undefined> {
  return ctx.registry.get(id)?.info() ?? (await ctx.parking.get(id))?.info
}

// Missing and not-visible answer the same 404: whether a session exists outside the caller's scope is not its business.
export async function resolveSession(ctx: ServerContext, id: string, auth: AuthContext): Promise<ResolvedSession> {
  const runner = ctx.registry.get(id)
  const parked = runner ? null : await ctx.parking.get(id)
  const info = runner?.info() ?? parked?.info
  if (!info || !ctx.auth.canSee(auth, info)) {
    fail(404, 'session not found')
  }
  return { runner, parked, info }
}

export function requireLive(runner: Runner | undefined, why: string): Runner {
  if (!runner) {
    fail(409, `session is parked (${why})`)
  }
  return runner
}

// Reads stay open on a past conversation; everything else would change or wake it. Erasing it is the one exception.
export function requireWritable(resolved: ResolvedSession, method: string | undefined, erase: boolean): void {
  if (resolved.parked && isArchived(resolved.parked) && method !== 'GET' && method !== 'HEAD' && !erase) {
    fail(409, 'conversation is archived')
  }
}
