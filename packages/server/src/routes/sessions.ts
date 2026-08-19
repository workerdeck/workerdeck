/** `{basePath}/sessions[/:id[...]]` — the list, the create, and every
 * per-session subroute. One `canSee` gate covers all of them, byte-identical
 * to the unknown-id answer: whether a session exists elsewhere is not this
 * caller's business. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  CreateSessionRequest,
  ResolvePermissionRequest,
  UpdateSessionRequest,
} from '@workerdeck/protocol'
import { contentTypeFor, json, readJsonBody } from '../lib/http.ts'
import type { SessionRoute } from '../lib/parse-route.ts'
import type { AuthContext } from '../services/auth.ts'
import { isDormant } from '../services/session-store.ts'
import type { ServerContext } from '../context.ts'
import { handleAttachments } from './attachments.ts'
import { handleMcp } from './mcp.ts'
import { handleProducedFiles } from './produced-files.ts'
import { handleToolResult } from './tool-results.ts'

export async function handleSessions(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: SessionRoute,
  auth: AuthContext,
): Promise<void> {
  const { attachmentStore, auth: authSvc, availability, bridge, factory, parking, producedFiles, registry } = ctx

  if (!route.id) {
    if (req.method === 'GET') {
      // Parked sessions are live sessions that happen to have no runner right
      // now — leaving them out would read as "gone".
      const sessions = [...registry.list(), ...(await parking.listInfo())]
      json(res, 200, { sessions: sessions.filter((session) => authSvc.canSee(auth, session)) })
      return
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateSessionRequest
      const refusedScope = factory.applyScope(body, auth)
      if (refusedScope) {
        json(res, refusedScope.status, { error: refusedScope.error })
        return
      }
      const refused = factory.applyBypassPolicy(body)
      if (refused) {
        json(res, 403, { error: refused })
        return
      }
      const resolved = factory.resolveProfile(body.profile, auth.allowedProfiles)
      if (!resolved.ok) {
        json(res, resolved.status, { error: resolved.error })
        return
      }
      const unavailable = availability.checkAvailable(resolved.profile)
      if (unavailable) {
        json(res, unavailable.status, { error: unavailable.error })
        return
      }
      const refusedCwd = factory.checkCwd(body, resolved.profile)
      if (refusedCwd) {
        json(res, refusedCwd.status, { error: refusedCwd.error })
        return
      }
      const badRequest =
        factory.checkPermissionMode(body.permissionMode, resolved.profile) ??
        factory.checkEngineGrants(body, resolved.profile)
      if (badRequest) {
        json(res, 400, { error: badRequest })
        return
      }
      factory.stripInertFields(body, resolved.profile)
      // Resolved name (even when implicit) so SessionInfo.profile is always set.
      body.profile = resolved.profile?.name
      const runner = await factory.createRunner(factory.buildRunnerConfig(body))
      factory.watchAuthSource(runner)
      json(res, 201, { session: runner.info() })
      return
    }
    json(res, 405, { error: 'method not allowed' })
    return
  }

  const runner = registry.get(route.id)
  // A parked session has no runner but is very much alive: it reads, lists, and
  // serves its files from the snapshot, and only waking it needs a rebuild.
  const parked = runner ? null : await parking.get(route.id)
  if (!runner && !parked) {
    json(res, 404, { error: 'session not found' })
    return
  }
  // One gate for every `/sessions/:id/*` subroute below — GET, PATCH, DELETE,
  // files, produced, attachments, mcp, and the permission decision that would
  // otherwise let another scope answer this session's approvals. Byte-identical
  // to the unknown-id answer above: whether a session exists elsewhere is not
  // this caller's business.
  if (!authSvc.canSee(auth, runner?.info() ?? parked!.info)) {
    json(res, 404, { error: 'session not found' })
    return
  }
  if (route.attachments) {
    await handleAttachments(
      ctx,
      req,
      res,
      route.id,
      runner?.info() ?? parked!.info,
      route.attachmentId,
    )
    return
  }
  if (route.mcp) {
    if (!runner) {
      json(res, 409, { error: 'session is parked (wake it before asking about MCP)' })
      return
    }
    await handleMcp(ctx, req, res, runner, route.mcpServer)
    return
  }
  if (route.files) {
    // Deliverables live in the session's in-memory VFS — downloadable while
    // the session lives (durability is a persistence-tier concern, not ours).
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    // A dormant session has no VFS to serve: its files, if it made any, live
    // wherever the engine wrote them, not in a snapshot we kept.
    const snapshotFiles = parked && !isDormant(parked) ? parked.snapshot.vfs : undefined
    const vfs =
      runner?.vfs ??
      (snapshotFiles && {
        list: () => Object.keys(snapshotFiles).sort(),
        read: (path: string) => snapshotFiles[path]!,
      })
    if (!vfs) {
      json(res, 404, { error: 'session has no file store' })
      return
    }
    if (route.filePath === undefined) {
      const files = vfs.list().map((path) => ({ path, bytes: vfs.read(path)?.length ?? 0 }))
      json(res, 200, { files })
      return
    }
    const content = vfs.read(route.filePath)
    if (content === undefined) {
      json(res, 404, { error: `no such file: ${route.filePath}` })
      return
    }
    const filename = route.filePath.split('/').pop() || 'file'
    res.writeHead(200, {
      'content-type': contentTypeFor(filename),
      'content-length': Buffer.byteLength(content),
      // RFC 5987 filename* so non-ASCII names survive; plain filename for the rest.
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      // Agent-authored content must never render on this origin.
      'x-content-type-options': 'nosniff',
    })
    res.end(content)
    return
  }
  if (route.produced) {
    await handleProducedFiles(ctx, req, res, route.id, route.producedFileId)
    return
  }
  if (route.resultSeq !== undefined) {
    const snapshot = parked && !isDormant(parked) ? parked.snapshot.events : undefined
    handleToolResult(
      req,
      res,
      runner?.eventAt?.bind(runner) ??
        (snapshot && ((seq: number) => snapshot.find((event) => event.seq === seq))),
      route.resultSeq,
    )
    return
  }
  if (route.permissionId) {
    // REST counterpart of the WS permission_decision command, for controllers
    // without a socket (e.g. answering a job's AskUserQuestion from a webhook).
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as ResolvePermissionRequest
    if (body?.behavior !== 'allow' && body?.behavior !== 'deny') {
      json(res, 400, { error: "behavior must be 'allow' or 'deny'" })
      return
    }
    if (!runner) {
      json(res, 409, { error: 'session is parked (it has no pending permission requests)' })
      return
    }
    if (!runner.resolvePermission(route.permissionId, body)) {
      json(res, 404, { error: 'permission request not found (already resolved or expired)' })
      return
    }
    json(res, 200, { resolved: true })
    return
  }
  if (req.method === 'GET') {
    json(res, 200, { session: runner?.info() ?? parked!.info })
    return
  }
  if (req.method === 'PATCH') {
    // Rename. A parked session has no runner to carry the change and its
    // snapshot belongs to the park store, so it is refused rather than lied to.
    if (!runner) {
      json(res, 409, { error: 'session is parked (wake it before renaming)' })
      return
    }
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateSessionRequest
    if (body?.title !== undefined) {
      if (body.title !== null && typeof body.title !== 'string') {
        json(res, 400, { error: 'title must be a string or null' })
        return
      }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      runner.setTitle(title || undefined)
      // A rename emits no event, so nothing else would re-save the dormant
      // record — and the wake rebuilds from it. Without this the new name
      // survives only until the next restart.
      parking.touch(runner)
    }
    json(res, 200, { session: runner.info() })
    return
  }
  if (req.method === 'DELETE') {
    registry.remove(route.id)
    // Fail anything still bridged: the session is gone, so no answer can land.
    bridge.remove(route.id)
    // And drop any parked state, so a late execution result can't wake a session
    // the client just ended.
    await parking.discard(route.id)
    // The session is gone; so is anything it was holding for it.
    attachmentStore.drop(route.id)
    producedFiles.drop(route.id)
    json(res, 200, {
      session: runner?.info() ?? { ...parked!.info, status: 'closed' as const },
    })
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
