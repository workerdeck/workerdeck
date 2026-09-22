import { pickCreateSessionRequest, type CreateSessionRequest } from '@workerdeck/protocol'
import type { AiSdkRunnerConfig, CodexRunnerConfig, SessionRunnerConfig } from '@workerdeck/core'
import type { ServerContext } from '../context.ts'
import type { AuthContext } from '../services/auth.ts'

type HostOnlyKey = Exclude<keyof SessionRunnerConfig | keyof CodexRunnerConfig | keyof AiSdkRunnerConfig, keyof CreateSessionRequest>

// Every runner-config key that is not on the wire type. Typed as a record over that difference so a
// host-only field added to any engine's config without an entry here fails typecheck, as does an
// entry that has since been promoted onto CreateSessionRequest.
const HOST_ONLY_KEY_SET: Record<HostOnlyKey, true> = {
  epoch: true,
  queryFn: true,
  env: true,
  pathToClaudeCodeExecutable: true,
  extraOptions: true,
  instructions: true,
  defaultApprovalTimeoutMs: true,
  backfillHistory: true,
  historyFn: true,
  sessionInfoFn: true,
  peers: true,
  connectFn: true,
  codexHome: true,
  codexPathOverride: true,
  languageModel: true,
  tools: true,
  maxSteps: true,
  executor: true,
  executableTools: true,
  vfs: true,
  executionLimits: true,
  executionBackend: true,
  toolTitles: true,
  shouldApprove: true,
  resolveModel: true,
  reportMcpServers: true,
  onClose: true,
  restore: true,
}

export const HOST_ONLY_KEYS: ReadonlySet<string> = new Set(Object.keys(HOST_ONLY_KEY_SET))

export type VettedCreateRequest = { ok: true; request: CreateSessionRequest } | { ok: false; status: number; error: string }

// The one create-validation ladder, run by both create doors - `POST /sessions` and the
// `session` block of `POST /jobs`. The scope design claims the two are indistinguishable, so
// the order and the refusals have to come from a single place rather than two copies that can
// drift. The body is untrusted JSON: it is projected onto the wire type, never cast to it, and
// the projected object is what the ladder mutates (inert fields stripped, profile name pinned)
// and what the caller must hand on.
export function vetCreateRequest(ctx: ServerContext, body: unknown, auth: AuthContext): VettedCreateRequest {
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
  const refusedScope = factory.applyScope(req, auth)
  if (refusedScope) {
    return { ok: false, ...refusedScope }
  }
  const refused = factory.applyBypassPolicy(req)
  if (refused) {
    return { ok: false, status: 403, error: refused }
  }
  const resolved = factory.resolveProfile(req.profile, auth.allowedProfiles)
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, error: resolved.error }
  }
  const unavailable = availability.checkAvailable(resolved.profile)
  if (unavailable) {
    return { ok: false, ...unavailable }
  }
  const refusedCwd = factory.checkCwd(req, resolved.profile)
  if (refusedCwd) {
    return { ok: false, ...refusedCwd }
  }
  const badRequest = factory.checkPermissionMode(req.permissionMode, resolved.profile) ?? factory.checkEngineGrants(req, resolved.profile)
  if (badRequest) {
    return { ok: false, status: 400, error: badRequest }
  }
  factory.stripInertFields(req, resolved.profile)
  req.profile = resolved.profile?.name
  return { ok: true, request: req }
}
