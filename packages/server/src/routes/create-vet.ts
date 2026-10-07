import { pickCreateSessionRequest, type CreateSessionRequest, type ProfileInfo } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { HOST_ONLY_KEYS } from '../lib/host-only-keys.ts'
import type { Refusal } from '../lib/http.ts'
import { refusePermissionMode } from '../lib/permissions.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { AuthContext } from '../services/auth.ts'

export { HOST_ONLY_KEYS }

export type VettedCreateRequest = { ok: true; request: CreateSessionRequest } | { ok: false; status: number; error: string }

// The one create-validation ladder, run by both create doors - `POST /sessions` and the
// `session` block of `POST /jobs`. The scope design claims the two are indistinguishable, so
// the order and the refusals have to come from a single place rather than two copies that can
// drift. The body is untrusted JSON: it is projected onto the wire type, never cast to it, and
// the projected object is what the ladder mutates (inert fields stripped, profile name pinned)
// and what the caller must hand on.
// `owner` is set when the session's owner is already settled (an agent's), so its profile need not name one.
export function vetCreateRequest(ctx: ServerContext, body: unknown, auth: AuthContext, owner?: string): VettedCreateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: 'request body must be a JSON object' }
  }
  const hostOnly = Object.keys(body).filter((key) => HOST_ONLY_KEYS.has(key))
  if (hostOnly.length > 0) {
    return {
      ok: false,
      status: 400,
      error:
        `host-only runner config is not accepted on a session request: ${hostOnly.join(', ')} ` +
        "(set it from the gateway's buildRunnerConfig hook)",
    }
  }
  const req = pickCreateSessionRequest(body as Record<string, unknown>)
  const { availability, factory } = ctx
  const early = factory.applyScope(req, auth) ?? refusal(403, factory.applyBypassPolicy(req))
  if (early) {
    return { ok: false, ...early }
  }
  const resolved = factory.resolveProfile(req.profile, auth.allowedProfiles)
  if (!resolved.ok) {
    return resolved
  }
  const refused =
    refusal(403, refuseHostAuthority(ctx, req, resolved.profile, auth)) ??
    availability.checkAvailable(resolved.profile) ??
    factory.checkCwd(req, resolved.profile) ??
    refusal(400, factory.checkPermissionMode(req.permissionMode, resolved.profile) ?? factory.checkEngineGrants(req, resolved.profile)) ??
    (owner === undefined ? ownerRefusal(ctx, resolved.profile?.name) : null)
  if (refused) {
    return { ok: false, ...refused }
  }
  factory.stripInertFields(req, resolved.profile)
  req.profile = resolved.profile?.name
  return { ok: true, request: req }
}

function ownerRefusal(ctx: ServerContext, profile: string | undefined): Refusal | null {
  const resolved = ctx.owners.resolve(profile)
  return 'error' in resolved ? resolved : null
}

function refusal(status: number, error: string | null): Refusal | null {
  return error === null ? null : { status, error }
}

// A non-operator is an embedded end user: nothing on its request may reach past what the profile grants into the
// gateway's own authority over the host. Operators (the tenant model's one key) are untouched.
function refuseHostAuthority(
  ctx: ServerContext,
  req: CreateSessionRequest,
  profile: ProfileInfo | undefined,
  auth: AuthContext,
): string | null {
  if (ctx.auth.isOperator(auth)) {
    return null
  }
  const engine = engineOf(profile)
  const name = profile?.name ?? 'default'
  if ((engine === 'claude' || engine === 'codex') && !auth.allowedProfiles?.includes(name)) {
    return `profile '${name}' runs the ${engine} engine on the host; a non-operator caller needs it named in its allowedProfiles`
  }
  const mode = refusePermissionMode(req.permissionMode, { operator: false })
  if (mode) {
    return mode
  }
  if (req.allowDangerouslySkipPermissions) {
    return 'allowDangerouslySkipPermissions is reserved to operators'
  }
  if (req.settingSources !== undefined && req.settingSources.length > 0) {
    return 'settingSources is reserved to operators: it loads hooks and settings from the host'
  }
  const servers = typeof req.mcpServers === 'object' && req.mcpServers !== null ? Object.values(req.mcpServers) : []
  if (!servers.every(isRemoteMcpServer)) {
    return 'a stdio MCP server is reserved to operators: it runs a command on the host'
  }
  if (req.resume !== undefined && !ownsSdkSession(ctx, auth, req.resume)) {
    return 'resume is limited to a live session this caller can see'
  }
  return null
}

function ownsSdkSession(ctx: ServerContext, auth: AuthContext, sdkSessionId: string): boolean {
  return ctx.registry.list().some((info) => info.sdkSessionId === sdkSessionId && ctx.auth.canSee(auth, info))
}

function isRemoteMcpServer(server: unknown): boolean {
  const type = (server as { type?: unknown } | null)?.type
  return type === 'http' || type === 'sse'
}
