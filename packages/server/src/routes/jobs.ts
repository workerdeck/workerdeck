/** `{basePath}/jobs` + `{basePath}/queue` — job submission, listing, cancel,
 * and the gateway-wide queue stats. Jobs run as ordinary registry sessions;
 * these routes are the queue's REST face. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreateJobRequest } from '@workerdeck/protocol'
import { json, readJsonBody } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

export const handleJobs = async (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> => {
  const { auth: authSvc, availability, basePath, factory, queue } = ctx
  if (!queue) {
    json(res, 404, { error: 'job queue not configured' })
    return
  }
  if (pathname === basePath + '/queue') {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    // Gateway-wide counters across every scope, with no id to filter on.
    if (!authSvc.isOperator(auth)) {
      json(res, 404, { error: 'not found' })
      return
    }
    json(res, 200, { stats: await queue.stats() })
    return
  }
  const rest = pathname.slice((basePath + '/jobs').length).replace(/^\//, '')
  if (rest === '') {
    if (req.method === 'GET') {
      // Same rule as the sessions list, over the job's copy of the tags: the
      // queue must not be a side door into a session the caller cannot attach to.
      const jobs = await queue.list()
      json(res, 200, { jobs: jobs.filter((job) => authSvc.canSeeJob(auth, job)) })
      return
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateJobRequest
      if (!body.session || typeof body.session !== 'object') {
        json(res, 400, { error: 'session is required' })
        return
      }
      if (!body.session.prompt || typeof body.session.prompt !== 'string') {
        json(res, 400, { error: 'session.prompt is required' })
        return
      }
      const refusedScope = factory.applyScope(body.session, auth)
      if (refusedScope) {
        json(res, refusedScope.status, { error: refusedScope.error })
        return
      }
      const refused = factory.applyBypassPolicy(body.session)
      if (refused) {
        json(res, 403, { error: refused })
        return
      }
      const resolved = factory.resolveProfile(body.session.profile, auth.allowedProfiles)
      if (!resolved.ok) {
        json(res, resolved.status, { error: resolved.error })
        return
      }
      const unavailable = availability.checkAvailable(resolved.profile)
      if (unavailable) {
        json(res, unavailable.status, { error: unavailable.error })
        return
      }
      const refusedCwd = factory.checkCwd(body.session, resolved.profile)
      if (refusedCwd) {
        json(res, refusedCwd.status, { error: refusedCwd.error })
        return
      }
      const badRequest =
        factory.checkPermissionMode(body.session.permissionMode, resolved.profile) ??
        factory.checkEngineGrants(body.session, resolved.profile)
      if (badRequest) {
        json(res, 400, { error: badRequest })
        return
      }
      factory.stripInertFields(body.session, resolved.profile)
      // Normalize to the resolved name so an implicit single profile still lands
      // on JobInfo.profile and reaches the runner config at claim time.
      body.session.profile = resolved.profile?.name
      try {
        json(res, 201, { job: await queue.submit(body) })
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : 'invalid job' })
      }
      return
    }
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const id = decodeURIComponent(rest)
  if (id.includes('/')) {
    json(res, 404, { error: 'not found' })
    return
  }
  if (req.method === 'GET') {
    const job = await queue.get(id)
    if (job && authSvc.canSeeJob(auth, job)) {
      json(res, 200, { job })
    } else {
      json(res, 404, { error: 'job not found' })
    }
    return
  }
  if (req.method === 'DELETE') {
    // Checked before the cancel, not after: a refused caller must not be able
    // to kill a run and then be told it does not exist.
    const existing = await queue.get(id)
    if (!existing || !authSvc.canSeeJob(auth, existing)) {
      json(res, 404, { error: 'job not found' })
      return
    }
    const job = await queue.cancel(id)
    if (job) {
      json(res, 200, { job })
    } else {
      json(res, 404, { error: 'job not found' })
    }
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
