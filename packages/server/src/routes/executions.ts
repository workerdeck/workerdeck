import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolExecutionResult } from '@workerdeck/core'
import type { SubmitExecutionResultRequest } from '@workerdeck/protocol'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'
import { sessionInfoOf } from './session-lookup.ts'

export async function handleExecutionResult(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const { auth: authSvc, basePath, parking } = ctx
  const rest = pathname.slice((basePath + '/executions/').length).split('/')
  if (rest.length !== 2 || rest[1] !== 'result' || !rest[0]) {
    fail(404, 'not found')
  }
  requireMethod(req, 'POST')
  const executionId = decodeURIComponent(rest[0])
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as SubmitExecutionResultRequest
  let result: ToolExecutionResult
  if (body?.status === 'ok') {
    if (!body.output || typeof body.output !== 'object') {
      fail(400, "output is required for status 'ok'")
    }
    result = { status: 'ok', output: body.output.value, logs: body.logs }
  } else if (body?.status === 'failed') {
    if (typeof body.reason !== 'string' || typeof body.error !== 'string') {
      fail(400, "reason and error are required for status 'failed'")
    }
    result = { status: 'failed', reason: body.reason, error: body.error, logs: body.logs }
  } else {
    fail(400, "status must be 'ok' or 'failed'")
  }
  if (auth.allowedProfiles || auth.scope || ctx.options.authorizeSession) {
    const owner = parking.sessionFor(executionId)
    const info = owner === undefined ? undefined : await sessionInfoOf(ctx, owner)
    const profile = info?.profile
    // Indistinguishable from an unknown id on purpose: whether an execution exists elsewhere is not this caller's business.
    // A vanished session (`info === undefined`) refuses too - nobody passed canSee, and submitResult would disclose the owner id.
    const refused =
      owner === undefined ||
      info === undefined ||
      (auth.allowedProfiles !== undefined && profile !== undefined && !auth.allowedProfiles.includes(profile)) ||
      !authSvc.canSee(auth, info)
    if (refused) {
      fail(404, 'execution not found')
    }
  }
  const applied = await parking.submitResult(executionId, result)
  if (!applied) {
    fail(404, 'execution not found (unknown id, or its session has ended)')
  }
  json(res, 200, applied)
}
