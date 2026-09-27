import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreateJobRequest } from '@workerdeck/protocol'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import { vetCreateRequest } from './create-vet.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

export async function handleJobs(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const { auth: authSvc, basePath, queue } = ctx
  if (!queue) {
    fail(404, 'job queue not configured')
  }
  if (pathname === basePath + '/queue') {
    requireMethod(req, 'GET')
    if (!authSvc.isOperator(auth)) {
      fail(404, 'not found')
    }
    json(res, 200, { stats: await queue.stats() })
    return
  }
  const rest = pathname.slice((basePath + '/jobs').length).replace(/^\//, '')
  if (rest === '') {
    requireMethod(req, 'GET', 'POST')
    if (req.method === 'GET') {
      const jobs = await queue.list()
      json(res, 200, { jobs: jobs.filter((job) => authSvc.canSeeJob(auth, job)) })
      return
    }
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateJobRequest | null
    if (!body?.session || typeof body.session !== 'object') {
      fail(400, 'session is required')
    }
    const prompt = body.session.prompt
    if (!prompt || typeof prompt !== 'string') {
      fail(400, 'session.prompt is required')
    }
    const vetted = vetCreateRequest(ctx, body.session, auth)
    if (!vetted.ok) {
      fail(vetted.status, vetted.error)
    }
    try {
      // The projected block is what gets stored: the queue spreads the record's session into a runner config later.
      json(res, 201, { job: await queue.submit({ ...body, session: { ...vetted.request, prompt } }) })
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'invalid job' })
    }
    return
  }
  const id = decodeURIComponent(rest)
  if (id.includes('/')) {
    fail(404, 'not found')
  }
  requireMethod(req, 'GET', 'DELETE')
  // Checked before the cancel: a refused caller must not be able to kill a run and then be told it does not exist.
  const existing = await queue.get(id)
  if (!existing || !authSvc.canSeeJob(auth, existing)) {
    fail(404, 'job not found')
  }
  const job = req.method === 'GET' ? existing : await queue.cancel(id)
  if (!job) {
    fail(404, 'job not found')
  }
  json(res, 200, { job })
}
