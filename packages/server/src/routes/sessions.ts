import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreateSessionRequest, ResolvePermissionRequest, UpdateSessionRequest } from '@workerdeck/protocol'
import { contentTypeFor, json, readJsonBody } from '../lib/http.ts'
import type { SessionRoute } from '../lib/parse-route.ts'
import type { AuthContext } from '../services/auth.ts'
import { isDormant } from '../services/session-store.ts'
import type { ServerContext } from '../context.ts'
import { vetCreateRequest } from './create-vet.ts'
import { handleAttachments } from './attachments.ts'
import { handleMcp } from './mcp.ts'
import { handleProducedFiles } from './produced-files.ts'
import { handleProjectIcon } from './project-icon.ts'
import { handleToolResult } from './tool-results.ts'

export const handleSessions = async (
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: SessionRoute,
  auth: AuthContext,
): Promise<void> => {
  const { attachmentStore, auth: authSvc, bridge, factory, parking, producedFiles, projects, registry } = ctx

  if (!route.id) {
    if (req.method === 'GET') {
      const sessions = [...registry.list(), ...(await parking.listInfo())]
      json(res, 200, {
        sessions: sessions.filter((session) => authSvc.canSee(auth, session)).map((session) => projects.withProject(session)),
      })
      return
    }
    if (req.method === 'POST') {
      const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateSessionRequest
      const refusal = vetCreateRequest(ctx, body, auth)
      if (refusal) {
        json(res, refusal.status, { error: refusal.error })
        return
      }
      const runner = await factory.createRunner(factory.buildRunnerConfig(body))
      factory.watchAuthSource(runner)
      json(res, 201, { session: projects.withProject(runner.info()) })
      return
    }
    json(res, 405, { error: 'method not allowed' })
    return
  }

  const runner = registry.get(route.id)
  const parked = runner ? null : await parking.get(route.id)
  if (!runner && !parked) {
    json(res, 404, { error: 'session not found' })
    return
  }
  if (!authSvc.canSee(auth, runner?.info() ?? parked!.info)) {
    json(res, 404, { error: 'session not found' })
    return
  }
  if (route.attachments) {
    await handleAttachments(ctx, req, res, route.id, runner?.info() ?? parked!.info, route.attachmentId)
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
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
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
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'x-content-type-options': 'nosniff',
    })
    res.end(content)
    return
  }
  if (route.produced) {
    await handleProducedFiles(ctx, req, res, route.id, route.producedFileId)
    return
  }
  if (route.projectIcon) {
    handleProjectIcon(projects, req, res, (runner?.info() ?? parked!.info).cwd)
    return
  }
  if (route.resultSeq !== undefined) {
    const snapshot = parked && !isDormant(parked) ? parked.snapshot.events : undefined
    handleToolResult(
      req,
      res,
      runner?.eventAt?.bind(runner) ?? (snapshot && ((seq: number) => snapshot.find((event) => event.seq === seq))),
      route.resultSeq,
    )
    return
  }
  if (route.permissionId) {
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
    json(res, 200, { session: projects.withProject(runner?.info() ?? parked!.info) })
    return
  }
  if (req.method === 'PATCH') {
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
      parking.touch(runner)
    }
    json(res, 200, { session: projects.withProject(runner.info()) })
    return
  }
  if (req.method === 'DELETE') {
    registry.remove(route.id)
    bridge.remove(route.id)
    await parking.discard(route.id)
    attachmentStore.drop(route.id)
    producedFiles.drop(route.id)
    json(res, 200, {
      session: projects.withProject(runner?.info() ?? { ...parked!.info, status: 'closed' as const }),
    })
    return
  }
  json(res, 405, { error: 'method not allowed' })
}
