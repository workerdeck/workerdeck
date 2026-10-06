import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AVATAR_SEED_MAX } from '@workerdeck/core'
import type {
  AgentConfig,
  AgentResponse,
  CreateAgentRequest,
  RetireAgentRequest,
  SessionInfo,
  UpdateAgentRequest,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import { isAgentRefusal, type AgentService } from '../services/agents.ts'
import type { StoredAgent } from '../services/agent-store.ts'
import type { AvatarImage } from '../services/avatars.ts'
import { vetCreateRequest } from './create-vet.ts'
import { sessionInfoOf } from './session-lookup.ts'

export async function handleAgents(
  ctx: ServerContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  auth: AuthContext,
): Promise<void> {
  const agents = ctx.agents
  const rest = pathname.slice((ctx.basePath + '/agents').length).replace(/^\//, '')
  if (rest === '') {
    requireMethod(req, 'GET', 'POST')
    if (req.method === 'GET') {
      json(res, 200, { agents: agents.list() })
      return
    }
    await createAgent(ctx, agents, req, res, auth)
    return
  }
  const [id, action, ...extra] = rest.split('/').map(decodeURIComponent)
  const agent = id === undefined ? undefined : agents.get(id)
  if (!agent || extra.length > 0) {
    fail(404, 'agent not found')
  }
  if (action === 'restart') {
    requireMethod(req, 'POST')
    const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as { prompt?: unknown }
    const previous = agent.sessionId === undefined ? undefined : ctx.registry.get(agent.sessionId)
    const created = await startSession(ctx, agent, typeof body.prompt === 'string' ? body.prompt : undefined, auth)
    const status = previous?.info().status
    if (previous && status !== 'closed' && status !== 'failed') {
      previous.close('server')
    }
    await respond(ctx, res, 200, await bindWithAvatar(ctx, agent, created), created)
    return
  }
  if (action === 'avatar') {
    requireMethod(req, 'POST')
    const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as { seed?: unknown }
    const changed = await rerollAvatar(ctx, agent, readSeed(body.seed))
    await respond(ctx, res, 200, changed)
    return
  }
  if (action === 'avatar-preview.png') {
    requireMethod(req, 'GET')
    const seed = readSeed(new URL(req.url ?? '', 'http://x').searchParams.get('seed') ?? undefined)
    if (seed === undefined) {
      fail(400, 'seed is required')
    }
    const recipe = await rollFor(ctx, agent, seed)
    await sendImage(req, res, await ctx.avatars!.still(recipe))
    return
  }
  if (action === 'avatar.png' || action === 'avatar-busy.png') {
    requireMethod(req, 'GET')
    await sendAvatar(ctx, req, res, agent, action === 'avatar-busy.png')
    return
  }
  if (action !== undefined) {
    fail(404, 'agent not found')
  }
  requireMethod(req, 'GET', 'PATCH', 'DELETE')
  if (req.method === 'GET') {
    await respond(ctx, res, 200, agent)
    return
  }
  if (req.method === 'PATCH') {
    const patch = (await readJsonBody(req, ctx.maxBodyBytes)) as UpdateAgentRequest
    const updated = await agents.update(agent.id, isRecord(patch) ? patch : {})
    if (isAgentRefusal(updated)) {
      fail(updated.status, updated.error)
    }
    await respond(ctx, res, 200, updated)
    return
  }
  const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as RetireAgentRequest
  const members = body.members === 'retire' ? 'retire' : 'release'
  const outcome = await agents.retire(agent.id, members)
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  for (const gone of outcome.retired) {
    const runner = gone.sessionId === undefined ? undefined : ctx.registry.get(gone.sessionId)
    const status = runner?.info().status
    if (runner && status !== 'closed' && status !== 'failed') {
      runner.close('client')
    }
  }
  json(res, 200, { retired: outcome.retired.map((a) => a.id), released: outcome.released.map((a) => a.id) })
}

async function createAgent(ctx: ServerContext, agents: AgentService, req: IncomingMessage, res: ServerResponse, auth: AuthContext) {
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateAgentRequest
  if (!isRecord(body)) {
    fail(400, 'request body must be a JSON object')
  }
  if (body.adopt !== undefined) {
    await adoptSession(ctx, agents, res, body)
    return
  }
  const draft = agents.draft(body)
  if (isAgentRefusal(draft)) {
    fail(draft.status, draft.error)
  }
  const created = await startSession(ctx, draft, typeof body.prompt === 'string' ? body.prompt : undefined, auth)
  await respond(ctx, res, 201, await bindWithAvatar(ctx, draft, created), created)
}

async function adoptSession(ctx: ServerContext, agents: AgentService, res: ServerResponse, body: CreateAgentRequest) {
  if (typeof body.adopt !== 'string') {
    fail(400, 'adopt must be a session id')
  }
  const info = await sessionInfoOf(ctx, body.adopt)
  if (!info) {
    fail(404, 'session not found')
  }
  if (agents.bySession(info.id)) {
    fail(409, 'that session already belongs to an agent')
  }
  const draft = agents.draft({ name: body.name ?? info.title, config: { ...configOf(info), ...body.config }, lead: body.lead })
  if (isAgentRefusal(draft)) {
    fail(draft.status, draft.error)
  }
  await respond(ctx, res, 201, await bindWithAvatar(ctx, draft, info))
}

function readSeed(seed: unknown): string | undefined {
  if (seed === undefined || seed === null || seed === '') {
    return undefined
  }
  if (typeof seed !== 'string' || seed.trim().length === 0 || seed.length > AVATAR_SEED_MAX) {
    fail(400, `seed must be a string of at most ${AVATAR_SEED_MAX} characters`)
  }
  return seed.trim()
}

async function rollFor(ctx: ServerContext, agent: StoredAgent, seed: string): Promise<unknown> {
  if (!ctx.avatars) {
    fail(404, 'this gateway draws no avatars')
  }
  const session = agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId)
  const recipe = await rollAvatar(ctx, { ...agent, avatarSeed: seed }, session)
  if (recipe === undefined) {
    fail(503, 'the avatar pack could not be loaded')
  }
  return recipe
}

// A new seed (random unless given) rolls and saves a new avatar; the agent's `avatar` address changes with it.
export async function rerollAvatar(ctx: ServerContext, agent: StoredAgent, seed?: string): Promise<StoredAgent> {
  const next = seed ?? randomUUID()
  const recipe = await rollFor(ctx, agent, next)
  return ctx.agents.save({ ...agent, avatarSeed: next, avatarRecipe: recipe })
}

async function bindWithAvatar(ctx: ServerContext, agent: StoredAgent, session: SessionInfo): Promise<StoredAgent> {
  const recipe = agent.avatarRecipe ?? (await rollAvatar(ctx, agent, session))
  return ctx.agents.bind(recipe === undefined ? agent : { ...agent, avatarRecipe: recipe }, session.id)
}

async function rollAvatar(ctx: ServerContext, agent: StoredAgent, session: SessionInfo | undefined): Promise<unknown> {
  if (!ctx.avatars) {
    return undefined
  }
  const project = session ? (ctx.projects.withProject(session).project?.root ?? session.cwd) : undefined
  try {
    return await ctx.avatars.roll(agent.avatarSeed, session?.engine, project || undefined)
  } catch {
    return undefined
  }
}

async function sendAvatar(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, agent: StoredAgent, busy: boolean): Promise<void> {
  const avatars = ctx.avatars
  if (!avatars) {
    fail(404, 'this gateway draws no avatars')
  }
  let recipe = agent.avatarRecipe
  if (recipe === undefined) {
    const session = agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId)
    recipe = await rollAvatar(ctx, agent, session)
    if (recipe === undefined) {
      fail(503, 'the avatar pack could not be loaded')
    }
    await ctx.agents.save({ ...agent, avatarRecipe: recipe })
  }
  const image = busy ? await avatars.busy(recipe) : await avatars.still(recipe)
  if (!image) {
    fail(404, 'this avatar pack has no busy animation')
  }
  await sendImage(req, res, image)
}

// Revalidated rather than cached for a day: the address is stable per agent while the avatar can change.
async function sendImage(req: IncomingMessage, res: ServerResponse, image: AvatarImage): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'image/png', etag: image.etag, 'cache-control': 'private, no-cache' }
  if (image.durations) {
    headers['x-frame-durations'] = image.durations.join(',')
  }
  if (req.headers['if-none-match'] === image.etag) {
    res.writeHead(304, headers).end()
    return
  }
  res.writeHead(200, headers).end(Buffer.from(image.png))
}

async function startSession(ctx: ServerContext, agent: StoredAgent, prompt: string | undefined, auth: AuthContext): Promise<SessionInfo> {
  const { config } = agent
  const request = {
    cwd: config.cwd,
    profile: config.profile,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    permissionMode: config.permissionMode,
    allowDangerouslySkipPermissions: config.permissionMode === 'bypassPermissions' ? true : undefined,
    agentContextReset: config.agentContextReset ?? true,
    prompt,
  }
  const vetted = vetCreateRequest(ctx, stripUndefined(request), auth)
  if (!vetted.ok) {
    fail(vetted.status, vetted.error)
  }
  const runner = await ctx.factory.createRunner(ctx.factory.buildRunnerConfig(vetted.request, { operator: ctx.auth.isOperator(auth) }), {
    brief: config.brief?.trim() || undefined,
    agent: true,
  })
  return runner.info()
}

async function respond(ctx: ServerContext, res: ServerResponse, status: number, agent: StoredAgent, session?: SessionInfo): Promise<void> {
  const info = session ?? (agent.sessionId === undefined ? undefined : await sessionInfoOf(ctx, agent.sessionId))
  const body: AgentResponse = { agent: ctx.agents.public(agent) }
  if (info) {
    body.session = ctx.projects.withProject(info)
  }
  json(res, status, body)
}

function configOf(info: SessionInfo): AgentConfig {
  return stripUndefined({
    cwd: info.cwd || undefined,
    profile: info.profile,
    model: info.model,
    reasoningEffort: info.effort ?? undefined,
    permissionMode: info.permissionMode,
  })
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
