import type { IncomingMessage, ServerResponse } from 'node:http'
import { PROTOCOL_VERSION, type GatewayAgentDefaults, type GatewayMeta } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { json, type Refusal } from '../lib/http.ts'
import { machineId } from '../lib/machine-id.ts'
import { parseSessionRoute } from '../lib/parse-route.ts'
import type { AuthContext } from '../services/auth.ts'
import { handleAgents } from './agents.ts'
import { handleExecutionResult } from './executions.ts'
import { handleHostFiles } from './fs.ts'
import { handleJobs } from './jobs.ts'
import { handleProfiles } from './profiles.ts'
import { handleSdkSessions } from './sdk-sessions.ts'
import { handleSessions } from './sessions.ts'

// `any` is every authenticated principal; `operator` answers a non-operator with the same 404 as a missing route,
// because those surfaces describe the gateway itself and there is nothing to filter.
export type RouteAuth = 'any' | 'operator'

export type RouteRefusal = Refusal

export type RouteSpec<M> = {
  match: (pathname: string, req: IncomingMessage) => M | undefined
  // Runs before authentication, so whatever it answers is answered to anyone.
  refuse?: (req: IncomingMessage, matched: M, draining: boolean) => RouteRefusal | undefined
  auth: RouteAuth
  handler: (req: IncomingMessage, res: ServerResponse, matched: M, auth: AuthContext) => Promise<void> | void
}

export type MatchedRoute = {
  auth: RouteAuth
  refuse: (draining: boolean) => RouteRefusal | undefined
  handle: (res: ServerResponse, auth: AuthContext) => Promise<void> | void
}

export type HttpRoute = (pathname: string, req: IncomingMessage) => MatchedRoute | undefined

const SHUTTING_DOWN: RouteRefusal = { status: 503, error: 'server is shutting down' }
const NOT_FOUND: RouteRefusal = { status: 404, error: 'not found' }

export function route<M>(spec: RouteSpec<M>): HttpRoute {
  return (pathname, req) => {
    const matched = spec.match(pathname, req)
    if (matched === undefined) {
      return undefined
    }
    return {
      auth: spec.auth,
      refuse: (draining) => spec.refuse?.(req, matched, draining),
      handle: (res, auth) => spec.handler(req, res, matched, auth),
    }
  }
}

export function httpRoutes(ctx: ServerContext): HttpRoute[] {
  const base = ctx.basePath
  const under = (prefix: string) => (pathname: string) => pathname === base + prefix || pathname.startsWith(base + prefix + '/')
  return [
    route({
      match: pathWhere((pathname) => under('/jobs')(pathname) || pathname === base + '/queue'),
      refuse: (req, pathname, draining) => (draining && req.method === 'POST' && pathname === base + '/jobs' ? SHUTTING_DOWN : undefined),
      auth: 'any',
      handler: (req, res, pathname, auth) => handleJobs(ctx, req, res, pathname, auth),
    }),
    route({
      match: pathWhere(under('/profiles')),
      auth: 'any',
      handler: (req, res, pathname, auth) => handleProfiles(ctx, req, res, pathname, auth),
    }),
    route({
      match: pathWhere(under('/agents')),
      auth: 'operator',
      handler: (req, res, pathname, auth) => handleAgents(ctx, req, res, pathname, auth),
    }),
    route({
      match: pathWhere((pathname) => pathname.startsWith(base + '/executions/')),
      auth: 'any',
      handler: (req, res, pathname, auth) => handleExecutionResult(ctx, req, res, pathname, auth),
    }),
    route({
      match: pathWhere((pathname) => pathname === base + '/sdk-sessions'),
      auth: 'operator',
      handler: (req, res, _, auth) => handleSdkSessions(ctx, req, res, auth),
    }),
    route({
      match: pathWhere((pathname) => pathname === base + '/meta'),
      auth: 'any',
      // Degrades rather than refusing: the fingerprint is only ever acted on by a client that also means to read this
      // machine's files, so it is gated behind the same principal as `/fs`.
      handler: (_, res, __, auth) =>
        json(res, 200, {
          protocolVersion: PROTOCOL_VERSION,
          ...(ctx.auth.isOperator(auth)
            ? { machineId: machineId(), ...(ctx.relayStatus ? { relay: ctx.relayStatus() } : {}), agents: agentDefaults(ctx) }
            : {}),
        } satisfies GatewayMeta),
    }),
    // Authenticated before the 404-when-unconfigured answer: an unauthenticated caller must not learn whether a
    // filesystem is exposed.
    route({
      match: pathWhere((pathname) => pathname.startsWith(base + '/fs/')),
      auth: 'operator',
      handler: (req, res, pathname) => handleHostFiles(ctx, req, res, pathname),
    }),
    route({
      match: (_, req) => {
        const parsed = parseSessionRoute(base, req.url ?? '/')
        return parsed && parsed.kind !== 'ws' ? parsed : undefined
      },
      // Starting a turn we have already promised to stop waiting for would make the drain unable to converge.
      // Existing sessions stay fully controllable, including approvals, which is how an operator unblocks one.
      refuse: (req, parsed, draining) => (draining && req.method === 'POST' && parsed.kind === 'collection' ? SHUTTING_DOWN : undefined),
      auth: 'any',
      handler: (req, res, parsed, auth) => handleSessions(ctx, req, res, parsed, auth),
    }),
  ]
}

export async function dispatchRoute(
  ctx: ServerContext,
  routes: HttpRoute[],
  req: IncomingMessage,
  res: ServerResponse,
  draining: boolean,
): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://internal').pathname
  const matched = firstMatch(routes, pathname, req)
  if (!matched) {
    json(res, NOT_FOUND.status, { error: NOT_FOUND.error })
    return
  }
  const refusal = matched.refuse(draining)
  if (refusal) {
    json(res, refusal.status, { error: refusal.error })
    return
  }
  const auth = await ctx.auth.authenticate(req)
  if (!auth.ok) {
    json(res, 401, { error: 'unauthorized' })
    return
  }
  if (matched.auth === 'operator' && !ctx.auth.isOperator(auth)) {
    json(res, NOT_FOUND.status, { error: NOT_FOUND.error })
    return
  }
  await matched.handle(res, auth)
}

function firstMatch(routes: HttpRoute[], pathname: string, req: IncomingMessage): MatchedRoute | undefined {
  for (const candidate of routes) {
    const matched = candidate(pathname, req)
    if (matched) {
      return matched
    }
  }
  return undefined
}

function pathWhere(test: (pathname: string) => boolean): (pathname: string) => string | undefined {
  return (pathname) => (test(pathname) ? pathname : undefined)
}

function agentDefaults(ctx: ServerContext): GatewayAgentDefaults {
  const allowShared = ctx.options.agentSharing?.allowShared !== false
  const owner = ctx.owners.defaultOwner()
  return {
    ...(owner === undefined ? {} : { owner }),
    ...(ctx.owners.multi() ? { multiOwner: true as const } : {}),
    sharing: allowShared && ctx.options.agentSharing?.default === 'shared' ? 'shared' : 'private',
    allowShared,
  }
}
