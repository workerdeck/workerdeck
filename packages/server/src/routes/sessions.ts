import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PeerSessionsResponse, ResolvePermissionRequest, SessionInfo, UpdateSessionRequest } from '@workerdeck/protocol'
import { contentTypeFor, fail, json, readJsonBody, requireMethod, sendUntrusted } from '../lib/http.ts'
import type { SessionItemRoute, SessionRoute } from '../lib/parse-route.ts'
import { permissionDecision } from '../lib/permissions.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { AuthContext } from '../services/auth.ts'
import { isDormant } from '../services/session-store.ts'
import type { ServerContext } from '../context.ts'
import { vetCreateRequest } from './create-vet.ts'
import { handleAttachments } from './attachments.ts'
import { handleMcp } from './mcp.ts'
import { handleProducedFiles } from './produced-files.ts'
import { handleProjectIcon } from './project-icon.ts'
import { requireLive, resolveSession, type ResolvedSession } from './session-lookup.ts'
import { handleShells } from './shells.ts'
import { handleToolResult } from './tool-results.ts'
import { sleepRunner } from './sleep.ts'

type ItemKind = SessionItemRoute['kind']

type SessionCall<K extends ItemKind> = ResolvedSession & {
  ctx: ServerContext
  req: IncomingMessage
  res: ServerResponse
  auth: AuthContext
  route: Extract<SessionItemRoute, { kind: K }>
}

type ItemHandlers = { [K in ItemKind]: (call: SessionCall<K>) => Promise<void> | void }

const ITEM_HANDLERS: ItemHandlers = {
  session: handleSession,
  ws: handleSession,
  attachments: ({ ctx, req, res, route, info }) => handleAttachments(ctx, req, res, route.id, info, route.attachmentId),
  mcp: ({ ctx, req, res, route, runner }) =>
    handleMcp(ctx, req, res, requireLive(runner, 'wake it before asking about MCP'), route.mcpServer),
  files: handleFiles,
  produced: ({ ctx, req, res, route }) => handleProducedFiles(ctx, req, res, route.id, route.producedFileId),
  shells: ({ ctx, req, res, route, runner, auth }) => handleShells(ctx, req, res, route, runner ?? null, ctx.auth.isOperator(auth)),
  'stop-task': handleStopTask,
  'background-task': handleBackgroundTask,
  'project-icon': ({ ctx, req, res, info }) => handleProjectIcon(ctx.projects, req, res, info.cwd),
  'tool-result': ({ req, res, route, runner, parked }) => {
    const snapshot = parked && !isDormant(parked) ? parked.snapshot.events : undefined
    handleToolResult(
      req,
      res,
      runner?.eventAt?.bind(runner) ?? (snapshot && ((seq: number) => snapshot.find((event) => event.seq === seq))),
      route.resultSeq,
    )
  },
  permission: handlePermission,
  peers: handlePeers,
  sleep: handleSleep,
}

export async function handleSessions(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  route: SessionRoute,
  auth: AuthContext,
): Promise<void> {
  if (route.kind === 'collection') {
    await handleCollection(ctx, req, res, auth)
    return
  }
  const resolved = await resolveSession(ctx, route.id, auth)
  const handler = ITEM_HANDLERS[route.kind] as (call: SessionCall<ItemKind>) => Promise<void> | void
  await handler({ ...resolved, ctx, req, res, auth, route })
}

async function handleCollection(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
  const { auth: authSvc, factory, parking, projects, registry } = ctx
  requireMethod(req, 'GET', 'POST')
  if (req.method === 'GET') {
    const sessions = [...registry.list(), ...(await parking.listInfo())]
    json(res, 200, {
      sessions: sessions.filter((session) => authSvc.canSee(auth, session)).map((session) => projects.withProject(session)),
    })
    return
  }
  const vetted = vetCreateRequest(ctx, await readJsonBody(req, ctx.maxBodyBytes), auth)
  if (!vetted.ok) {
    fail(vetted.status, vetted.error)
  }
  const runner = await factory.createRunner(factory.buildRunnerConfig(vetted.request, { operator: authSvc.isOperator(auth) }))
  json(res, 201, { session: projects.withProject(runner.info()) })
}

async function handleSession({ ctx, req, res, route, runner, parked, info }: SessionCall<'session' | 'ws'>): Promise<void> {
  const { attachmentStore, bridge, parking, producedFiles, projects, registry } = ctx
  requireMethod(req, 'GET', 'PATCH', 'DELETE')
  if (req.method === 'GET') {
    json(res, 200, { session: projects.withProject(info) })
    return
  }
  if (req.method === 'PATCH') {
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateSessionRequest
    if (body?.title !== undefined && body.title !== null && typeof body.title !== 'string') {
      fail(400, 'title must be a string or null')
    }
    const title = typeof body?.title === 'string' ? body.title.trim() || undefined : undefined
    if (!runner && parked) {
      const renamed = body?.title === undefined ? parked.info : await parking.retitle(route.id, title)
      json(res, 200, { session: projects.withProject(requireRenamed(renamed)) })
      return
    }
    const live = requireLive(runner, 'wake it before renaming')
    if (body?.title !== undefined) {
      live.setTitle(title)
      parking.touch(live)
    }
    json(res, 200, { session: projects.withProject(live.info()) })
    return
  }
  registry.remove(route.id)
  bridge.remove(route.id)
  await parking.discard(route.id)
  attachmentStore.drop(route.id)
  producedFiles.drop(route.id)
  json(res, 200, {
    session: projects.withProject(runner?.info() ?? { ...parked!.info, status: 'closed' as const }),
  })
}

async function handlePeers({ ctx, req, res, route }: SessionCall<'peers'>): Promise<void> {
  requireMethod(req, 'GET')
  if (!ctx.peers) {
    fail(404, 'peer messaging is off on this gateway')
  }
  const peers: PeerSessionsResponse['peers'] = await ctx.peers.list(route.id)
  json(res, 200, { peers })
}

function handleFiles({ req, res, route, runner, parked }: SessionCall<'files'>): void {
  requireMethod(req, 'GET')
  const snapshotFiles = parked && !isDormant(parked) ? parked.snapshot.vfs : undefined
  const vfs =
    runner?.vfs ??
    (snapshotFiles && {
      list: () => Object.keys(snapshotFiles).sort(),
      read: (path: string) => snapshotFiles[path]!,
    })
  if (!vfs) {
    fail(404, 'session has no file store')
  }
  if (route.filePath === undefined) {
    json(res, 200, { files: vfs.list().map((path) => ({ path, bytes: vfs.read(path)?.length ?? 0 })) })
    return
  }
  const content = vfs.read(route.filePath)
  if (content === undefined) {
    fail(404, `no such file: ${route.filePath}`)
  }
  const filename = route.filePath.split('/').pop() || 'file'
  sendUntrusted(res, filename, contentTypeFor(filename), content)
}

async function handleStopTask({ req, res, route, runner }: SessionCall<'stop-task'>): Promise<void> {
  requireMethod(req, 'POST')
  const live = requireLive(runner, 'it has no running tasks')
  if (!live.stopTask) {
    fail(501, `the ${engineOf(live.info())} engine cannot stop a task`)
  }
  if (!(await live.stopTask(route.stopTaskId))) {
    fail(404, 'no running task to stop')
  }
  json(res, 200, { ok: true })
}

async function handleBackgroundTask({ req, res, route, runner }: SessionCall<'background-task'>): Promise<void> {
  requireMethod(req, 'POST')
  const live = requireLive(runner, 'it has no running tasks')
  if (!live.backgroundTask) {
    fail(501, `the ${engineOf(live.info())} engine cannot move a task to the background`)
  }
  if (!(await live.backgroundTask(route.backgroundTaskId))) {
    fail(404, 'no foreground task to move to the background')
  }
  json(res, 200, { ok: true })
}

// A session that is not live has no engine child to stop, so asking it to sleep is already true.
async function handleSleep({ ctx, req, res, runner, info }: SessionCall<'sleep'>): Promise<void> {
  requireMethod(req, 'POST')
  if (runner) {
    await sleepRunner(runner)
  }
  json(res, 200, { session: ctx.projects.withProject(runner?.info() ?? info) })
}

async function handlePermission({ ctx, req, res, route, runner }: SessionCall<'permission'>): Promise<void> {
  requireMethod(req, 'POST')
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as ResolvePermissionRequest
  if (body?.behavior !== 'allow' && body?.behavior !== 'deny') {
    fail(400, "behavior must be 'allow' or 'deny'")
  }
  const live = requireLive(runner, 'it has no pending permission requests')
  if (!live.resolvePermission(route.permissionId, permissionDecision(body))) {
    fail(404, 'permission request not found (already resolved or expired)')
  }
  json(res, 200, { resolved: true })
}

function requireRenamed(info: SessionInfo | undefined): SessionInfo {
  if (!info) {
    fail(409, 'session woke while renaming; retry')
  }
  return info
}
