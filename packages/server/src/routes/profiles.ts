/** `{basePath}/profiles[/:name]` — the profile list every create form renders
 * from, and (with a `profileStore`) the management routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProfileInfo, UpdateProfileRequest } from '@workerdeck/protocol'
import { json, readJsonBody } from '../lib/http.ts'
import { readProfileConfig } from '../lib/profile-env.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

export async function handleProfiles(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const { auth: authSvc, availability, basePath, profiles } = ctx
  const saveManaged = async (incoming: ProfileInfo): Promise<void> => {
    const saved = await profiles.saveManaged(incoming)
    if (!saved.ok) {
      json(res, saved.status, { error: saved.error })
    } else {
      json(res, 200, { profile: saved.profile })
    }
  }
  const rest = pathname.slice((basePath + '/profiles').length).replace(/^\//, '')
  if (rest === '') {
    if (req.method === 'GET') {
      const visible = auth.allowedProfiles ? profiles.all().filter((p) => auth.allowedProfiles!.includes(p.name)) : profiles.all()
      // Stale-while-revalidate: answer from the cache, re-probe anything older than the TTL.
      availability.refresh(visible)
      json(res, 200, {
        profiles: visible.map((p) => profiles.forResponse(p)),
        canManage: profiles.manageGuard(auth) === null,
      })
      return
    }
    if (req.method === 'POST') {
      const refused = profiles.manageGuard(auth)
      if (refused) {
        json(res, refused.status, { error: refused.error })
        return
      }
      const body = (await readJsonBody(req, ctx.maxBodyBytes)) as ProfileInfo
      if (!body.name || typeof body.name !== 'string') {
        json(res, 400, { error: 'name is required' })
        return
      }
      if (profiles.get(body.name)) {
        json(res, 409, { error: `profile already exists: ${body.name}` })
        return
      }
      await saveManaged(body)
      return
    }
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const name = decodeURIComponent(rest)
  const profile = name.includes('/') ? undefined : profiles.get(name)
  if (!profile) {
    json(res, 404, { error: 'profile not found' })
    return
  }
  if (auth.allowedProfiles && !auth.allowedProfiles.includes(profile.name)) {
    json(res, 403, { error: `profile not allowed: ${profile.name}` })
    return
  }
  if (req.method === 'GET') {
    // The config snapshot is the operator's own config directory read back — skill, agent,
    // command and hook names, and the *keys* of the env in `settings.json`. A profile a
    // scoped end user may *run* is not thereby a directory they may inventory, so it is
    // withheld from a non-operator while the profile record itself still answers.
    json(res, 200, {
      profile: profiles.forResponse(profile),
      config: authSvc.isOperator(auth) ? readProfileConfig(profile) : undefined,
    })
    return
  }
  if (req.method === 'PATCH' || req.method === 'DELETE') {
    const refused = profiles.manageGuard(auth) ?? profiles.declaredGuard(profile)
    if (refused) {
      json(res, refused.status, { error: refused.error })
      return
    }
    if (req.method === 'DELETE') {
      await ctx.options.profileStore!.delete(profile.name)
      await profiles.refreshStored()
      res.writeHead(204).end()
      return
    }
    const patch = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateProfileRequest
    // `name` is the route, not the body — a rename would orphan every session
    // and job already pinned to the old one.
    await saveManaged({ ...profile, ...patch, name: profile.name })
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
