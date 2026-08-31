import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProfileInfo, SdkSessionSummary } from '@workerdeck/protocol'
import { json } from '../lib/http.ts'
import { cwdAllowed, engineOf } from '../lib/profile-env.ts'
import type { SdkSessionLister } from '../options.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

// A summary with no `cwd` cannot be shown to be inside the roots, so it is dropped.
function withinRoots(sessions: SdkSessionSummary[], roots: string[], limit?: number, offset = 0): SdkSessionSummary[] {
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
    // Implicit only when unambiguous AND permitted: a caller scoped away from the one profile falls back to the legacy listing.
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
        // A bare listing spans every project on the host, so it filters after listing — which is why the paging is applied here too.
        json(res, 200, { sdkSessions: withinRoots(await lister({}), roots, limit, offset) })
        return
      }
    }
    json(res, 200, { sdkSessions: await lister({ dir, limit, offset }) })
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : 'failed to list sessions' })
  }
}
