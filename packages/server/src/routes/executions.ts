/**
 * `POST {basePath}/executions/:executionId/result` — a deferred executor delivering its
 * outcome. Wakes the parked session and applies the result to its agent loop.
 *
 * Scoped like every other session route: a result is trusted tool input, so settling an
 * execution outside the caller's scope would be a way to steer another tenant's loop.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolExecutionResult } from '@workerdeck/core'
import type { SubmitExecutionResultRequest } from '@workerdeck/protocol'
import { json, readJsonBody } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'

export const handleExecutionResult = async (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> => {
  const { auth: authSvc, basePath, parking, registry } = ctx
  const rest = pathname.slice((basePath + '/executions/').length).split('/')
  if (rest.length !== 2 || rest[1] !== 'result' || !rest[0]) {
    json(res, 404, { error: 'not found' })
    return
  }
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  const executionId = decodeURIComponent(rest[0])
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as SubmitExecutionResultRequest
  let result: ToolExecutionResult
  if (body?.status === 'ok') {
    if (!body.output || typeof body.output !== 'object') {
      json(res, 400, { error: "output is required for status 'ok'" })
      return
    }
    result = { status: 'ok', output: body.output.value, logs: body.logs }
  } else if (body?.status === 'failed') {
    if (typeof body.reason !== 'string' || typeof body.error !== 'string') {
      json(res, 400, { error: "reason and error are required for status 'failed'" })
      return
    }
    result = { status: 'failed', reason: body.reason, error: body.error, logs: body.logs }
  } else {
    json(res, 400, { error: "status must be 'ok' or 'failed'" })
    return
  }
  if (auth.allowedProfiles || auth.scope || ctx.options.authorizeSession) {
    const owner = parking.sessionFor(executionId)
    const info = owner === undefined ? undefined : (registry.get(owner)?.info() ?? (await parking.get(owner))?.info)
    const profile = info?.profile
    // Indistinguishable from an unknown id on purpose: whether an execution exists elsewhere
    // is not this caller's business.
    const refused =
      owner === undefined ||
      (auth.allowedProfiles !== undefined && profile !== undefined && !auth.allowedProfiles.includes(profile)) ||
      (info !== undefined && !authSvc.canSee(auth, info))
    if (refused) {
      json(res, 404, { error: 'execution not found' })
      return
    }
  }
  const applied = await parking.submitResult(executionId, result)
  if (!applied) {
    json(res, 404, { error: 'execution not found (unknown id, or its session has ended)' })
    return
  }
  json(res, 200, applied)
}
