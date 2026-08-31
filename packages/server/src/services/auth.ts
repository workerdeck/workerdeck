import type { IncomingMessage } from 'node:http'
import type { JobInfo, SessionInfo } from '@workerdeck/protocol'
import { readScope, scopeMatches } from '../lib/scope.ts'
import type { WorkerServerOptions } from '../options.ts'
import type { SessionRegistry } from './registry.ts'

export type AuthContext = {
  ok: boolean
  allowedProfiles?: string[]
  canManageProfiles?: boolean
  principal?: unknown
  scope?: Record<string, string>
  operator?: boolean
}

export type AuthService = ReturnType<typeof createAuthService>

export const createAuthService = (deps: {
  options: Pick<WorkerServerOptions, 'authenticate' | 'authorizeSession'>
  refs: { registry?: SessionRegistry }
}) => {
  const { options, refs } = deps

  const authenticate = async (req: IncomingMessage): Promise<AuthContext> => {
    if (!options.authenticate) {
      return { ok: true }
    }
    const principal = await options.authenticate(req)
    if (principal === null || principal === undefined || principal === false) {
      return { ok: false }
    }
    const allowed = (principal as { allowedProfiles?: unknown }).allowedProfiles
    const scope = readScope((principal as { scope?: unknown }).scope)
    return {
      ok: true,
      principal,
      scope: scope && Object.keys(scope).length > 0 ? scope : undefined,
      operator:
        typeof (principal as { operator?: unknown }).operator === 'boolean' ? (principal as { operator: boolean }).operator : undefined,
      allowedProfiles: Array.isArray(allowed) && allowed.every((p) => typeof p === 'string') ? (allowed as string[]) : undefined,
      canManageProfiles: (principal as { canManageProfiles?: unknown }).canManageProfiles === true,
    }
  }

  const canSee = (auth: AuthContext, session: SessionInfo): boolean => {
    if (!options.authorizeSession) {
      return scopeMatches(auth.scope, session.scope)
    }
    try {
      return options.authorizeSession(auth.principal, session) === true
    } catch {
      return false
    }
  }

  const canSeeJob = (auth: AuthContext, job: JobInfo): boolean => {
    const live = job.sessionId ? refs.registry!.get(job.sessionId)?.info() : undefined
    if (live) {
      return canSee(auth, live)
    }
    if (!options.authorizeSession) {
      return scopeMatches(auth.scope, job.scope)
    }
    return canSee(auth, {
      id: job.sessionId ?? job.id,
      status: job.status === 'running' ? 'running' : job.status === 'parked' ? 'parked' : job.status === 'queued' ? 'starting' : 'closed',
      cwd: job.cwd,
      profile: job.profile,
      createdAt: job.createdAt,
      lastSeq: 0,
      pendingPermissionCount: 0,
      scope: job.scope,
    })
  }

  const isOperator = (auth: AuthContext): boolean => auth.operator ?? (auth.scope === undefined && !options.authorizeSession)

  return { authenticate, canSee, canSeeJob, isOperator }
}
