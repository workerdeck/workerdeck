import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Runner } from '@workerdeck/core'
import { fail, json, readJsonBody, requireMethod, sendUntrusted } from '../lib/http.ts'
import type { SessionItemRoute } from '../lib/parse-route.ts'
import { shellPermitted, SHELL_REFUSAL, type ShellRegistry } from '../services/shells.ts'
import type { ServerContext } from '../context.ts'

const AGENT_WRITE_BODY_MAX = 1024

export async function handleShells(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: Extract<SessionItemRoute, { kind: 'shells' }>,
  runner: Runner | null,
  operator: boolean,
): Promise<void> {
  const { shells } = ctx
  const sessionId = route.id
  if (!shells) {
    fail(404, SHELL_REFUSAL)
  }
  // Reading a shell is reading host output: the command, the cwd and every byte it printed. `canSee` on the session is
  // not enough, because a scoped principal can see a session an operator ran `$` in. The `hostCwd` leg of
  // `shellPermitted` is about whether a `$` may *run* and needs a live runner, which a parked session has not got, so
  // reads gate on the operator leg alone and the write arms below keep the full check.
  if (!operator) {
    fail(403, SHELL_REFUSAL)
  }
  if (route.shellId === undefined) {
    requireMethod(req, 'GET')
    json(res, 200, { shells: shells.list(sessionId) })
    return
  }
  if (route.shellAction === 'kill') {
    requirePermittedPost(shells, req, runner)
    json(res, 200, { shell: found(shells.kill(sessionId, route.shellId)) })
    return
  }
  if (route.shellAction === 'agent-write') {
    const live = requirePermittedPost(shells, req, runner)
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req, AGENT_WRITE_BODY_MAX)
    } catch {
      fail(400, 'invalid JSON body')
    }
    if (typeof body.enabled !== 'boolean') {
      fail(400, 'enabled must be a boolean')
    }
    if (body.enabled && live.info().shellAgentWrite === undefined) {
      fail(409, 'the agent has no shell write tools on this session (shell.agentWrite is read-only)')
    }
    let shell
    try {
      shell = shells.setAgentWrite(sessionId, route.shellId, body.enabled)
    } catch (error) {
      fail(409, error instanceof Error ? error.message : String(error))
    }
    json(res, 200, { shell: found(shell) })
    return
  }
  requireMethod(req, 'GET')
  if (route.shellAction === 'output') {
    const url = new URL(req.url ?? '/', 'http://internal')
    const requested = url.searchParams.get('view')
    const view = requested === 'raw' || requested === 'screen' ? requested : 'text'
    const tailParam = url.searchParams.get('tail')
    const tail = tailParam === null ? undefined : Number(tailParam)
    if (tail !== undefined && (!Number.isInteger(tail) || tail <= 0)) {
      fail(400, 'tail must be a positive integer')
    }
    const output = found(await shells.output(sessionId, route.shellId, { view, tail }))
    sendUntrusted(res, `${route.shellId}.txt`, 'text/plain; charset=utf-8', Buffer.from(output, 'utf8'))
    return
  }
  json(res, 200, { shell: found(shells.get(sessionId, route.shellId)) })
}

function requirePermittedPost(shells: ShellRegistry, req: IncomingMessage, runner: Runner | null): Runner {
  requireMethod(req, 'POST')
  if (!runner || !shellPermitted(shells, runner, true)) {
    fail(403, SHELL_REFUSAL)
  }
  return runner
}

function found<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    fail(404, 'shell not found')
  }
  return value
}
