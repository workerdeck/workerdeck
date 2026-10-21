import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  GENERATION_HEADER,
  isJobRun,
  readStatusLabelInput,
  type PeerSessionsResponse,
  type ResolvePermissionRequest,
  type SessionAgentRequest,
  type SessionInfo,
  type UpdateSessionRequest,
  type UpdateSessionResponse,
} from '@workerdeck/protocol'
import { contentTypeFor, fail, json, readJsonBody, requireMethod, sendUntrusted } from '../lib/http.ts'
import type { SessionItemRoute, SessionRoute } from '../lib/parse-route.ts'
import { permissionDecision } from '../lib/permissions.ts'
import { engineOf } from '../lib/profile-env.ts'
import type { AuthContext } from '../services/auth.ts'
import { isDormant } from '../services/session-store.ts'
import type { ServerContext } from '../context.ts'
import { CUT_IN_PROGRESS } from '../services/lifecycle-locks.ts'
import { vetCreateRequest } from './create-vet.ts'
import { handleAttachments } from './attachments.ts'
import { handleConversations } from './conversations.ts'
import { handleMcp } from './mcp.ts'
import { handleProducedFiles } from './produced-files.ts'
import { handleProjectIcon } from './project-icon.ts'
import { createNamedSession, editSettings, endSession, identityOf, nameSession, retireAgent, unnameSession } from './named-sessions.ts'
import { listSessions, requireLive, resolveSession, type ResolvedSession } from './session-lookup.ts'
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
  conversations: () => fail(404, 'not found'),
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
    const snapshot = parked && !isDormant(parked) ? parked.snapshot?.events : undefined
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
  if (route.kind === 'conversations') {
    await handleConversations(ctx, req, res, route.id, route.conversation, auth)
    return
  }
  const mutating = req.method !== 'GET' && req.method !== 'HEAD'
  if (!mutating) {
    const resolved = await resolveSession(ctx, route.id, auth)
    await dispatchItem(ctx, req, res, auth, route, resolved)
    return
  }
  const before = await resolveSession(ctx, route.id, auth)
  if (ctx.locks.gated(route.id)) {
    fail(409, CUT_IN_PROGRESS)
  }
  // Protocol 2: a mutating call names the conversation it was meant for, and a stale or missing one is refused, a
  // DELETE included. Re-checked under the session's lifecycle lock, so a call queued behind a cut never lands on n+1.
  const expected = expectedConversation(ctx, req, route.id)
  const recheck = async (): Promise<ResolvedSession> => {
    const resolved = await resolveSession(ctx, route.id, auth)
    const current = ctx.records.conversationOf(route.id) ?? 1
    if (current !== expected) {
      fail(409, `the session moved on to conversation ${current}`)
    }
    return resolved
  }
  const agent = route.kind === 'session' && req.method === 'DELETE' ? ctx.agents.get(route.id) : undefined
  if (agent) {
    // Retiring locks the agent's members too, so it takes the locks itself rather than under this route's.
    if (!ctx.auth.isOperator(auth)) {
      fail(403, `${agent.name} is an agent; only an operator can delete it`)
    }
    await retireAgent(ctx, agent.id, 'release', async () => void (await recheck()))
    json(res, 200, { session: ctx.projects.withProject({ ...before.info, status: 'closed' }) })
    return
  }
  await ctx.locks.run([route.id], async () => {
    await dispatchItem(ctx, req, res, auth, route, await recheck())
  })
}

function expectedConversation(ctx: ServerContext, req: IncomingMessage, id: string): number {
  const header = req.headers[GENERATION_HEADER]
  const current = ctx.records.conversationOf(id) ?? 1
  if (typeof header !== 'string') {
    fail(409, `this call must name its conversation (${GENERATION_HEADER}); the session is on conversation ${current}`)
  }
  const named = Number(header)
  if (!Number.isInteger(named) || named !== current) {
    fail(409, `the session moved on to conversation ${current}`)
  }
  return named
}

async function dispatchItem(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthContext,
  route: SessionItemRoute,
  resolved: ResolvedSession,
): Promise<void> {
  const handler = ITEM_HANDLERS[route.kind] as (call: SessionCall<ItemKind>) => Promise<void> | void
  await handler({ ...resolved, ctx, req, res, auth, route })
}

async function handleCollection(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
  const { auth: authSvc, factory, projects } = ctx
  requireMethod(req, 'GET', 'POST')
  if (req.method === 'GET') {
    const sessions = await listSessions(ctx, new URL(req.url ?? '', 'http://x').searchParams.get('closed') === '1')
    json(res, 200, {
      sessions: sessions.filter((session) => authSvc.canSee(auth, session)).map((session) => projects.withProject(session)),
    })
    return
  }
  const body = await readJsonBody(req, ctx.maxBodyBytes)
  const named = isRecord(body) && body.agent !== undefined ? body.agent : undefined
  if (named !== undefined) {
    if (!authSvc.isOperator(auth)) {
      fail(403, 'only an operator can name a session')
    }
    if (!isRecord(named)) {
      fail(400, 'agent must be an object')
    }
    const { agent: _agent, ...request } = body as Record<string, unknown>
    const created = await createNamedSession(ctx, identityOf(named as SessionAgentRequest), request, auth)
    json(res, 201, { session: projects.withProject(created.session) })
    return
  }
  const vetted = vetCreateRequest(ctx, body, auth)
  if (!vetted.ok) {
    fail(vetted.status, vetted.error)
  }
  const runner = await factory.createRunner(factory.buildRunnerConfig(vetted.request, { operator: authSvc.isOperator(auth) }))
  json(res, 201, { session: projects.withProject(runner.info()) })
}

async function handleSession({ ctx, req, res, auth, route, runner, parked, info }: SessionCall<'session' | 'ws'>): Promise<void> {
  const { parking, projects } = ctx
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
    const label = body?.statusLabel === undefined ? undefined : readStatusLabelInput(body.statusLabel)
    if (typeof label === 'string') {
      fail(400, label)
    }
    // Settings write the record before anything else could refuse, so they never share a PATCH with another key.
    if (body?.config !== undefined && (body.agent !== undefined || body.title !== undefined || body.statusLabel !== undefined)) {
      fail(400, 'config is patched on its own, without agent, title or statusLabel')
    }
    const config = body?.config === undefined ? undefined : readSettingsPatch(body.config)
    if (config && isJobRun(info)) {
      fail(409, 'a job run has no next conversation to configure')
    }
    const settings = config ? await editSettings(ctx, info, config, auth) : undefined
    const reply = (session: SessionInfo): void =>
      json(res, 200, { session: projects.withProject(session), ...(settings ? { settings } : {}) } satisfies UpdateSessionResponse)
    if (body?.agent !== undefined) {
      await renameIdentity(ctx, auth, info, body.agent)
    }
    if (body?.title === undefined && label === undefined) {
      reply(ctx.registry.get(route.id)?.info() ?? info)
      return
    }
    if (!runner && parked) {
      let renamed: SessionInfo | undefined = parked.info
      if (body?.title !== undefined) {
        renamed = await parking.retitle(route.id, title)
      }
      if (label !== undefined && renamed) {
        const relabeled = await parking.relabel(route.id, label)
        if (relabeled === 'parked') {
          fail(409, 'session is parked mid-turn; set its status once it wakes')
        }
        renamed = relabeled
      }
      reply(requireRenamed(renamed))
      return
    }
    const live = requireLive(runner, 'wake it before renaming')
    if (body?.title !== undefined) {
      live.setTitle(title)
      parking.touch(live)
    }
    if (label !== undefined) {
      if (!live.setStatusLabel) {
        fail(501, 'this engine does not carry a status label')
      }
      live.setStatusLabel(label)
    }
    reply(live.info())
    return
  }
  await endSession(ctx, route.id)
  json(res, 200, { session: projects.withProject(runner?.info() ?? { ...(parked?.info ?? info), status: 'closed' as const }) })
}

// Naming and un-naming are the `/agents` routes' to guard: operator only, an un-name refused in a team.
async function renameIdentity(ctx: ServerContext, auth: AuthContext, info: SessionInfo, agent: unknown): Promise<void> {
  if (!ctx.auth.isOperator(auth)) {
    fail(403, 'only an operator can name a session')
  }
  if (agent === null) {
    if (!ctx.agents.get(info.id)) {
      fail(409, 'this session has no name to remove')
    }
    await unnameSession(ctx, info.id)
    return
  }
  if (!isRecord(agent)) {
    fail(400, 'agent must be an object or null')
  }
  await nameSession(ctx, info, agent as SessionAgentRequest)
}

const SETTING_TYPES = {
  cwd: 'string',
  profile: 'string',
  model: 'string',
  reasoningEffort: 'string',
  permissionMode: 'string',
  agentContextReset: 'boolean',
} as const

function readSettingsPatch(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(400, 'config must be an object')
  }
  for (const [key, setting] of Object.entries(value)) {
    const type = (SETTING_TYPES as Record<string, string>)[key]
    if (type === undefined) {
      fail(400, `config.${key} is not a session setting; settings are ${Object.keys(SETTING_TYPES).join(', ')}`)
    }
    if (setting !== null && typeof setting !== type) {
      fail(400, `config.${key} must be a ${type} or null`)
    }
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  const snapshotFiles = parked && !isDormant(parked) ? parked.snapshot?.vfs : undefined
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
