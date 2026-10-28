import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AVATAR_SEED_MAX } from '@workerdeck/core'
import {
  agentFaceError,
  isOwnerName,
  mergeAgentFace,
  rollFace,
  type AgentFace,
  type AgentFacePatch,
  type AgentResponse,
  type CreateAgentRequest,
  type InviteRemoteMemberRequest,
  type RetireAgentRequest,
  type RetiredAgentsResponse,
  type SessionInfo,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import type { AuthContext } from '../services/auth.ts'
import { isAgentRefusal, type AgentRefusal } from '../services/agents.ts'
import type { StoredAgent } from '../services/agent-store.ts'
import {
  agentInfoOf,
  createNamedSession,
  finishRetired,
  pastConversations,
  requestFromConfig,
  retireAgent,
  faceProject,
  updateAgent,
} from './named-sessions.ts'
import { conversationGuard, expectedGenerationOf } from './conversations.ts'
import { sessionInfoOf } from './session-lookup.ts'

const CREATE_FIELDS = new Set<string>(['name', 'config', 'prompt', 'lead', 'owner', 'sharing', 'crossOwner'] satisfies (keyof CreateAgentRequest)[])

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
      if (new URL(req.url ?? '', 'http://x').searchParams.get('retired') === '1') {
        const retired = await Promise.all(
          agents.tombstones().map(async (tombstone) => agents.retiredInfo(tombstone, await pastConversations(ctx, tombstone.id, auth))),
        )
        json(res, 200, { retired } satisfies RetiredAgentsResponse)
        return
      }
      const listed = agents.list().map((info) => agents.get(info.id)!)
      json(res, 200, { agents: await Promise.all(listed.map(async (agent) => agentInfoOf(ctx, agent, await ctx.records.get(agent.id)))) })
      return
    }
    await createAgent(ctx, req, res, auth)
    return
  }
  const [id, action, ...extra] = rest.split('/').map(decodeURIComponent)
  const tombstone = id === undefined ? undefined : agents.tombstone(id)
  if (tombstone && action === undefined && req.method === 'DELETE') {
    await ctx.locks.run([tombstone.id], () => finishRetired(ctx, tombstone.id))
    json(res, 200, { retired: [tombstone.id], released: [] })
    return
  }
  const agent = id === undefined ? undefined : agents.get(id)
  if (!agent || extra.length > (action === 'remote-members' ? 1 : 0)) {
    fail(404, 'agent not found')
  }
  if (action === 'remote-members') {
    await remoteMembers(ctx, req, res, agent, extra[0])
    return
  }
  if (action === 'avatar') {
    requireMethod(req, 'POST')
    const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as { seed?: unknown; face?: unknown }
    if (body.face !== undefined) {
      const error = agentFaceError(body.face)
      if (error) {
        fail(400, error)
      }
    }
    const changed = await changeFace(ctx, agent, body.face === undefined ? { seed: readSeed(body.seed) } : { face: body.face as AgentFace })
    if (isAgentRefusal(changed)) {
      fail(changed.status, changed.error)
    }
    await respond(ctx, res, 200, changed)
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
    const updated = await updateAgent(ctx, agent, isRecord(patch) ? patch : {}, auth)
    if (isAgentRefusal(updated)) {
      fail(updated.status, updated.error)
    }
    await respond(ctx, res, 200, updated)
    return
  }
  const body = ((await readJsonBody(req, ctx.maxBodyBytes)) ?? {}) as RetireAgentRequest
  const guard = conversationGuard(ctx, agent.id, auth, expectedGenerationOf(body))
  const outcome = await retireAgent(ctx, agent.id, body.members === 'retire' ? 'retire' : 'release', async () =>
    guard(await ctx.records.get(agent.id)),
  )
  json(res, 200, { retired: outcome.retired.map((a) => a.id), released: outcome.released.map((a) => a.id) })
}

async function createAgent(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, auth: AuthContext) {
  const body = (await readJsonBody(req, ctx.maxBodyBytes)) as CreateAgentRequest
  if (!isRecord(body)) {
    fail(400, 'request body must be a JSON object')
  }
  const unknown = Object.keys(body).filter((key) => !CREATE_FIELDS.has(key))
  if (unknown.length > 0) {
    fail(400, `unsupported field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`)
  }
  const config = isRecord(body.config) ? body.config : {}
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
  const created = await createNamedSession(ctx, { ...body, config }, requestFromConfig(config, prompt), auth)
  await respond(ctx, res, 201, created.agent, created.session)
}

async function remoteMembers(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, lead: StoredAgent, member?: string) {
  const teams = ctx.teams
  if (!teams) {
    fail(409, 'this gateway is not connected to a relay')
  }
  let outcome: StoredAgent | AgentRefusal
  if (member === undefined) {
    requireMethod(req, 'POST')
    const body = (await readJsonBody(req, ctx.maxBodyBytes)) as InviteRemoteMemberRequest
    if (!isRecord(body) || typeof body.agent !== 'string') {
      fail(400, 'agent must be an agent id on another gateway (gateway:agentId)')
    }
    if (body.owner !== undefined && !isOwnerName(body.owner)) {
      fail(400, 'owner must be 1 to 32 lowercase letters, digits or dashes')
    }
    outcome = await teams.invite(lead, body.agent, body.owner)
  } else {
    requireMethod(req, 'DELETE')
    const invite = new URL(req.url ?? '', 'http://x').searchParams.get('invite') ?? undefined
    outcome = await teams.removeMember(lead, member, invite)
  }
  if (isAgentRefusal(outcome)) {
    fail(outcome.status, outcome.error)
  }
  await respond(ctx, res, 200, outcome)
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

// A seed (random unless given) rolls a new face, `parts` merge over the current one, `face` replaces it whole.
export async function changeFace(
  ctx: ServerContext,
  agent: StoredAgent,
  request: { seed?: string; parts?: AgentFacePatch; face?: AgentFace },
): Promise<StoredAgent | AgentRefusal> {
  const session = await sessionInfoOf(ctx, agent.id)
  if (request.parts) {
    const error = agentFaceError(request.parts, true)
    if (error) {
      return { status: 400, error }
    }
  }
  const seed = request.parts || request.face ? undefined : (request.seed ?? randomUUID())
  return ctx.agents.patch(agent.id, (current) => {
    if (request.face) {
      return { ...current, face: request.face }
    }
    if (request.parts) {
      return { ...current, face: mergeAgentFace(current.face ?? rollFace(current.avatarSeed, faceProject(ctx, current, session)), request.parts) }
    }
    return { ...current, avatarSeed: seed!, face: rollFace(seed!, faceProject(ctx, current, session)) }
  })
}

async function respond(ctx: ServerContext, res: ServerResponse, status: number, agent: StoredAgent, session?: SessionInfo): Promise<void> {
  const info = session ?? (await sessionInfoOf(ctx, agent.id))
  const current = ctx.agents.get(agent.id) ?? agent
  const body: AgentResponse = { agent: agentInfoOf(ctx, current, await ctx.records.get(agent.id)) }
  if (info) {
    body.session = ctx.projects.withProject(info)
  }
  json(res, status, body)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
