import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ToolExecutionResult } from '@workerdeck/core'
import type { SubmitExecutionResultRequest } from '@workerdeck/protocol'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import type { ServerContext } from '../context.ts'
import { ROTATING } from '../services/handovers.ts'
import { SessionFenced } from '../services/parking.ts'
import { entryInfo } from './conversations.ts'
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
  const ended = ctx.cuts.endedExecution(executionId)
  if (ended) {
    // Authorized on the ended conversation's own frozen projection, exactly as its history is.
    const info = entryInfo(ended.id, ended.entry)
    const profile = ended.entry.profile
    const scoped = auth.allowedProfiles || auth.scope || ctx.options.authorizeSession
    if (
      scoped &&
      ((auth.allowedProfiles !== undefined && profile !== undefined && !auth.allowedProfiles.includes(profile)) ||
        !authSvc.canSee(auth, info))
    ) {
      fail(404, 'execution not found')
    }
    fail(409, `execution belongs to conversation ${ended.entry.n}, which has ended`)
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
  const holder = parking.sessionFor(executionId)
  if (holder !== undefined && ctx.handovers.gated(holder)) {
    fail(409, ROTATING)
  }
  const applied = await parking.submitResult(executionId, result).catch((error: unknown) => {
    if (error instanceof SessionFenced) {
      fail(409, ROTATING)
    }
    throw error
  })
  if (!applied) {
    fail(404, 'execution not found (unknown id, or its session has ended)')
  }
  json(res, 200, applied)
}
