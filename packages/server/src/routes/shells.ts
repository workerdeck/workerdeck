import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runner } from '@workerdeck/core'
import { json, untrustedDownloadHeaders } from '../lib/http.ts'
import type { SessionRoute } from '../lib/parse-route.ts'
import { shellPermitted, SHELL_REFUSAL } from '../services/shells.ts'
import type { ServerContext } from '../context.ts'

export async function handleShells(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: SessionRoute,
  runner: Runner | null,
  operator: boolean,
): Promise<void> {
  const { shells } = ctx
  const sessionId = route.id!
  if (!shells) {
    json(res, 404, { error: SHELL_REFUSAL })
    return
  }
  // Reading a shell is reading host output: the command, the cwd and every byte it printed. `canSee` on the session is
  // not enough, because a scoped principal can see a session an operator ran `$` in. The `hostCwd` leg of
  // `shellPermitted` is about whether a `$` may *run* and needs a live runner, which a parked session has not got, so
  // reads gate on the operator leg alone and the kill arm below keeps the full check.
  if (!operator) {
    json(res, 403, { error: SHELL_REFUSAL })
    return
  }
  if (route.shellId === undefined) {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    json(res, 200, { shells: shells.list(sessionId) })
    return
  }
  if (route.shellAction === 'kill') {
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!runner || !shellPermitted(shells, runner, operator)) {
      json(res, 403, { error: SHELL_REFUSAL })
      return
    }
    const shell = shells.kill(sessionId, route.shellId)
    if (!shell) {
      json(res, 404, { error: 'shell not found' })
      return
    }
    json(res, 200, { shell })
    return
  }
  if (req.method !== 'GET') {
    json(res, 405, { error: 'method not allowed' })
    return
  }
  if (route.shellAction === 'output') {
    const url = new URL(req.url ?? '/', 'http://internal')
    const view = url.searchParams.get('view') === 'raw' ? 'raw' : 'text'
    const tailParam = url.searchParams.get('tail')
    const tail = tailParam === null ? undefined : Number(tailParam)
    if (tail !== undefined && (!Number.isInteger(tail) || tail <= 0)) {
      json(res, 400, { error: 'tail must be a positive integer' })
      return
    }
    const output = await shells.output(sessionId, route.shellId, { view, tail })
    if (output === undefined) {
      json(res, 404, { error: 'shell not found' })
      return
    }
    const body = Buffer.from(output, 'utf8')
    res.writeHead(200, untrustedDownloadHeaders(`${route.shellId}.txt`, 'text/plain; charset=utf-8', body.length))
    res.end(body)
    return
  }
  const shell = shells.get(sessionId, route.shellId)
  if (!shell) {
    json(res, 404, { error: 'shell not found' })
    return
  }
  json(res, 200, { shell })
}
