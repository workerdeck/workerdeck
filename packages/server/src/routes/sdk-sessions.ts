/**
 * `GET /sdk-sessions`, engine-aware: `?profile=` names whose on-disk store to list, and the
 * profile's engine adapter answers. Absent `profile`, the choice is implicit when the server
 * declares exactly one profile (the resolveProfile rule); with several, the Claude engine's
 * global store is listed — old clients cannot answer a new 400.
 *
 * The injectable `listSdkSessions` option predates the adapter layer and is honored for the
 * claude engine only, exactly like the injectable claude auth probe.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProfileInfo, SdkSessionSummary } from '@workerdeck/protocol'
import { json } from '../lib/http.ts'
import { cwdAllowed, engineOf } from '../lib/profile-env.ts'
import type { SdkSessionLister } from '../options.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

/** The sessions whose `cwd` is inside the roots, newest first, then paged. A summary with no
 * `cwd` cannot be shown to be inside them, so it is dropped. */
const withinRoots = (sessions: SdkSessionSummary[], roots: string[], limit?: number, offset = 0): SdkSessionSummary[] => {
  const allowed = sessions.filter((s) => s.cwd !== undefined && cwdAllowed(s.cwd, roots)).sort((a, b) => b.lastModified - a.lastModified)
  return limit === undefined ? allowed.slice(offset) : allowed.slice(offset, offset + limit)
}

export async function handleSdkSessions(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
  const { adapterFor, factory, profiles } = ctx
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const url = new URL(req.url ?? '/', 'http://internal')
  const dir = url.searchParams.get('dir') ?? undefined
  const roots = ctx.options.allowedCwdRoots
  const limit = Number(url.searchParams.get('limit') ?? '') || undefined
  const offset = Number(url.searchParams.get('offset') ?? '') || undefined
  const requested = url.searchParams.get('profile') ?? undefined
  let profile: ProfileInfo | undefined
  if (requested !== undefined) {
    const resolved = factory.resolveProfile(requested, auth.allowedProfiles)
    if (!resolved.ok) {
      json(res, resolved.status, { error: resolved.error })
      return
    }
    profile = resolved.profile
  } else {
    // Implicit only when unambiguous AND permitted — a caller scoped away from the server's
    // one profile falls back to the legacy listing rather than being handed a store it may
    // not create sessions in.
    const all = profiles.all()
    if (all.length === 1 && (!auth.allowedProfiles || auth.allowedProfiles.includes(all[0]!.name))) {
      profile = all[0]
    }
  }
  const adapter = adapterFor(profile?.engine)
  if (!adapter.capabilities.listSessions) {
    json(res, 400, {
      error: `profile '${profile?.name ?? 'default'}' runs the ${engineOf(profile)} engine, which has no browsable session store`,
    })
    return
  }
  const lister: SdkSessionLister =
    engineOf(profile) === 'claude' && ctx.listSdkSessions
      ? ctx.listSdkSessions
      : (params) => {
          if (!adapter.listSessions) {
            throw new Error(`the ${engineOf(profile)} engine does not implement session listing`)
          }
          return adapter.listSessions({
            ...params,
            profile,
            env: profile ? factory.sessionEnvFor(profile) : process.env,
          })
        }
  try {
    if (roots && roots.length > 0) {
      if (dir) {
        if (!cwdAllowed(dir, roots)) {
          json(res, 403, { error: 'dir is outside the allowed roots' })
          return
        }
      } else {
        // A bare listing spans ALL projects on the host, which is wider than the cwd policy,
        // so it lists and drops the ones outside the roots. Filtering, not fanning out over
        // the roots: `dir` selects one project directory and its worktrees, not everything
        // beneath it. Pagination is applied after the filter for the same reason, which is
        // why the underlying call takes neither bound.
        json(res, 200, { sdkSessions: withinRoots(await lister({}), roots, limit, offset) })
        return
      }
    }
    json(res, 200, { sdkSessions: await lister({ dir, limit, offset }) })
  } catch (error) {
    // The engine's own message (binary missing, store unreadable) is the useful one; listing
    // is read-only, so surfacing it verbatim is safe.
    json(res, 500, { error: error instanceof Error ? error.message : 'failed to list sessions' })
  }
}
