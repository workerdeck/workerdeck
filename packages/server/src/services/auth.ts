/**
 * Request authentication and the visibility predicates. One `canSee` behind the
 * list filter, every `/sessions/:id/*` route, the WS attach, the execution-result
 * door and the job routes — three callers, one predicate, so they cannot drift
 * into three subtly different answers.
 */
import type { IncomingMessage } from 'node:http'
import type { JobInfo, SessionInfo } from '@workerdeck/protocol'
import { readScope, scopeMatches } from '../lib/scope.ts'
import type { WorkerServerOptions } from '../options.ts'
import type { SessionRegistry } from './registry.ts'

export type AuthContext = {
  ok: boolean
  allowedProfiles?: string[]
  canManageProfiles?: boolean
  /** Whatever the host's `authenticate` returned, handed back to
   * `authorizeSession` verbatim — the host wrote both, and should get its own
   * object rather than this parsed shape. */
  principal?: unknown
  /** Parsed off the principal, duck-typed exactly like `allowedProfiles`.
   * Undefined = unrestricted. */
  scope?: Record<string, string>
  /** `principal.operator`, when the host stated it. Undefined = infer (see
   * {@link AuthService.isOperator}). */
  operator?: boolean
}

export type AuthService = ReturnType<typeof createAuthService>

export function createAuthService(deps: {
  options: Pick<WorkerServerOptions, 'authenticate' | 'authorizeSession'>
  refs: { registry?: SessionRegistry }
}) {
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
      // An empty object pins nothing, so it is unrestricted like an absent one —
      // an embedder must never read `{}` as "sees no sessions".
      scope: scope && Object.keys(scope).length > 0 ? scope : undefined,
      // Three-state on purpose: absent lets `isOperator` infer, and only an
      // actual boolean overrides the inference in either direction.
      operator:
        typeof (principal as { operator?: unknown }).operator === 'boolean' ? (principal as { operator: boolean }).operator : undefined,
      allowedProfiles: Array.isArray(allowed) && allowed.every((p) => typeof p === 'string') ? (allowed as string[]) : undefined,
      // Opt-in, and only ever true when the host says so: an unauthenticated dev
      // server (no `authenticate`) returns early above and manages nothing.
      canManageProfiles: (principal as { canManageProfiles?: unknown }).canManageProfiles === true,
    }
  }

  /** May this caller see — and therefore drive — this session? */
  const canSee = (auth: AuthContext, session: SessionInfo): boolean => {
    if (!options.authorizeSession) {
      return scopeMatches(auth.scope, session.scope)
    }
    try {
      return options.authorizeSession(auth.principal, session) === true
    } catch {
      // A policy that threw has not said yes. Fail closed rather than 500 the
      // route — a list of a hundred rows must not become a page-wide error
      // because one row's tags surprised the host's rule.
      return false
    }
  }

  /**
   * The job flavour of {@link canSee}. Once the run has started, the live
   * session's info is the real subject and the host's rule decides on it. Before
   * that (queued) and after (finished, session gone) there is no session to
   * hand over, so the predicate gets a **stub** built from what the job records:
   * its scope, its profile, its cwd.
   *
   * A stub rather than a fallback to the default rule, which is what this did
   * first and was wrong: a host policy *narrower* than plain tag-match (tags
   * plus a role, say) would have had queued jobs admitted — and cancelable — by
   * a peer it rejects. The predicate must be the only rule wherever it exists.
   * A host reading fields a queued job cannot have (model, status detail) gets
   * `undefined` and should treat the id and the scope as the load-bearing ones.
   */
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

  /**
   * Is this caller the operator, rather than someone embedded inside a scope?
   *
   * It decides the surfaces that answer about the **gateway** instead of about
   * one session — the host filesystem, the engine's own on-disk session store,
   * the queue and its firehose. There is nothing to filter on those and no
   * honest way to narrow them, so a non-operator is refused outright (404, like
   * every other miss).
   *
   * Two ways to be one, and the second exists because the first is not enough.
   * A principal carrying `scope` is an end user; a principal carrying neither
   * `scope` nor a policy is the operator — that is the unscoped default every
   * existing deployment relies on. But a host may write `authorizeSession` over
   * its *own* principal shape and never set `scope` at all, and reading that as
   * "everyone is the operator" is how a locked-down gateway ends up serving its
   * filesystem to end users. So **declaring a policy withdraws the default**,
   * and such a host marks its operator principals explicitly with
   * `operator: true` (`operator: false` forces the other way, at any time).
   */
  const isOperator = (auth: AuthContext): boolean => auth.operator ?? (auth.scope === undefined && !options.authorizeSession)

  return { authenticate, canSee, canSeeJob, isOperator }
}
