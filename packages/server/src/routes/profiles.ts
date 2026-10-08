import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CompleteAccountRequest,
  CompleteAccountResponse,
  ConnectAccountResponse,
  ProfileInfo,
  UpdateProfileRequest,
} from '@workerdeck/protocol'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import { readProfileConfig } from '../lib/profile-env.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ProfileService } from '../services/profiles.ts'
import type { ServerContext } from '../context.ts'

export async function handleProfiles(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const { auth: authSvc, availability, basePath, profiles } = ctx
  const rest = pathname.slice((basePath + '/profiles').length).replace(/^\//, '')
  if (rest === '') {
    requireMethod(req, 'GET', 'POST')
    if (req.method === 'GET') {
      const visible = auth.allowedProfiles ? profiles.all().filter((p) => auth.allowedProfiles!.includes(p.name)) : profiles.all()
      availability.refresh(visible)
      json(res, 200, {
        profiles: visible.map((p) => profiles.forResponse(p)),
        canManage: profiles.manageGuard(auth) === null,
      })
      return
    }
    refuseWith(profiles.manageGuard(auth))
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as ProfileInfo
    if (!body.name || typeof body.name !== 'string') {
      fail(400, 'name is required')
    }
    if (profiles.get(body.name)) {
      fail(409, `profile already exists: ${body.name}`)
    }
    await saveManaged(profiles, res, body)
    return
  }
  const [encoded = '', ...sub] = rest.split('/')
  const name = decodeURIComponent(encoded)
  const profile = name.includes('/') ? undefined : profiles.get(name)
  if (!profile) {
    fail(404, 'profile not found')
  }
  if (auth.allowedProfiles && !auth.allowedProfiles.includes(profile.name)) {
    fail(403, `profile not allowed: ${profile.name}`)
  }
  if (sub.length > 0) {
    await handleAccount(ctx, req, res, profile, sub.join('/'), auth)
    return
  }
  requireMethod(req, 'GET', 'PATCH', 'DELETE')
  if (req.method === 'GET') {
    json(res, 200, {
      profile: profiles.forResponse(profile),
      config: authSvc.isOperator(auth) ? readProfileConfig(profile) : undefined,
    })
    return
  }
  refuseWith(profiles.manageGuard(auth) ?? profiles.declaredGuard(profile))
  if (req.method === 'DELETE') {
    await ctx.options.profileStore!.delete(profile.name)
    await profiles.refreshStored()
    res.writeHead(204).end()
    return
  }
  const patch = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateProfileRequest
  await saveManaged(profiles, res, { ...profile, ...patch, name: profile.name })
}

async function handleAccount(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  profile: ProfileInfo,
  sub: string,
  auth: AuthContext,
): Promise<void> {
  const { accounts, profiles } = ctx
  if (sub !== 'account' && sub !== 'account/connect' && sub !== 'account/complete') {
    fail(404, 'not found')
  }
  requireMethod(req, sub === 'account' ? 'DELETE' : 'POST')
  refuseWith(await accounts.guard(auth, profile))
  if (sub === 'account') {
    await accounts.disconnect(profile)
    json(res, 200, { profile: profiles.forResponse(profile) })
    return
  }
  if (sub === 'account/connect') {
    const started = await accounts.connect(profile)
    if (!started.ok) {
      fail(started.status, started.error)
    }
    const { ok: _ok, ...response } = started
    json(res, 200, response satisfies ConnectAccountResponse)
    return
  }
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as Partial<CompleteAccountRequest>
  const code = typeof body.code === 'string' ? body.code.trim() : undefined
  if (typeof body.attemptId !== 'string' || (body.code !== undefined && (!code || code.length > 1024))) {
    fail(400, 'attemptId is required, and code when given must be non-empty')
  }
  const done = await accounts.complete(profile, body.attemptId, code)
  if (!done.ok) {
    fail(done.status, done.error)
  }
  const response: CompleteAccountResponse = { profile: profiles.forResponse(profile), ...(done.pending ? { pending: true } : {}) }
  json(res, 200, response)
}

function refuseWith(refused: { status: number; error: string } | null): void {
  if (refused) {
    fail(refused.status, refused.error)
  }
}

async function saveManaged(profiles: ProfileService, res: ServerResponse, incoming: ProfileInfo): Promise<void> {
  const saved = await profiles.saveManaged(incoming)
  if (!saved.ok) {
    fail(saved.status, saved.error)
  }
  json(res, 200, { profile: saved.profile })
}
