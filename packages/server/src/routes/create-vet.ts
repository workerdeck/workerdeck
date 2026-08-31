import type { CreateSessionRequest } from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import type { AuthContext } from '../services/auth.ts'

/**
 * The one create-validation ladder, run by both create doors — `POST /sessions` and the
 * `session` block of `POST /jobs`. The scope design claims the two are indistinguishable, so
 * the order and the refusals have to come from a single place rather than two copies that can
 * drift. Mutates `req`: strips inert fields and pins the resolved profile name.
 */
export const vetCreateRequest = (
  ctx: ServerContext,
  req: CreateSessionRequest,
  auth: AuthContext,
): { status: number; error: string } | null => {
  const { availability, factory } = ctx
  const refusedScope = factory.applyScope(req, auth)
  if (refusedScope) {
    return refusedScope
  }
  const refused = factory.applyBypassPolicy(req)
  if (refused) {
    return { status: 403, error: refused }
  }
  const resolved = factory.resolveProfile(req.profile, auth.allowedProfiles)
  if (!resolved.ok) {
    return { status: resolved.status, error: resolved.error }
  }
  const unavailable = availability.checkAvailable(resolved.profile)
  if (unavailable) {
    return unavailable
  }
  const refusedCwd = factory.checkCwd(req, resolved.profile)
  if (refusedCwd) {
    return refusedCwd
  }
  const badRequest = factory.checkPermissionMode(req.permissionMode, resolved.profile) ?? factory.checkEngineGrants(req, resolved.profile)
  if (badRequest) {
    return { status: 400, error: badRequest }
  }
  factory.stripInertFields(req, resolved.profile)
  req.profile = resolved.profile?.name
  return null
}
