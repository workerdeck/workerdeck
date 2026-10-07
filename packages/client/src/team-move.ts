import type { AgentResponse, GatewayRelayMeta } from '@workerdeck/protocol'
import type { WorkerDeckClient } from './index.ts'

// A drop in a session list, as the gateways see it. `lead: null` leaves the team; a mover without an agent is
// adopted first. `hostId` is the client's own name for a gateway, never its relay name. `crossOwner` carries the
// person's confirmation that the mover and the lead belong to different owners.
export type TeamMovePlan = {
  mover: { hostId: string; sessionId: string; agentId?: string; owner?: string }
  lead: { hostId: string; agentId: string } | null
  order?: number
  siblings?: Array<{ hostId: string; agentId: string; order: number }>
  crossOwner?: true
}

export type TeamInvitation = { hostId: string; leadAgentId: string; member: string; invite: string; state: 'withdrawn' | 'open' }

// `committed: 'unknown'` means the gateway never answered the join, so it may still go through.
export type TeamMoveOutcome = {
  committed: 'yes' | 'no' | 'unknown'
  error?: string
  adopted?: { hostId: string; agentId: string }
  invitation?: TeamInvitation
  unordered?: Array<{ hostId: string; agentId: string }>
}

type Step = { ok: true; response: AgentResponse } | { ok: false; definite: boolean; error: string }

// Across gateways a join takes two operator calls, one per side: the lead's gateway invites, then the mover's gateway
// joins through the relay. Holding a key for both gateways is the consent. Throws only before its first change.
export async function runTeamMove(
  plan: TeamMovePlan,
  clientOf: (hostId: string) => WorkerDeckClient | undefined,
  relayOf: (hostId: string) => GatewayRelayMeta | undefined = () => undefined,
): Promise<TeamMoveOutcome> {
  const client = clientOf(plan.mover.hostId)
  if (!client) {
    throw new Error('that gateway is not configured here')
  }
  const lead = plan.lead
  let outcome: TeamMoveOutcome
  if (!lead) {
    outcome = plan.mover.agentId ? settle(await step(client.updateAgent(plan.mover.agentId, { lead: null }))) : { committed: 'yes' }
  } else if (lead.hostId === plan.mover.hostId) {
    outcome = await sameGateway(plan, client, lead.agentId)
  } else {
    const leadClient = clientOf(lead.hostId)
    const leadRelay = relayOf(lead.hostId)
    const moverRelay = relayOf(plan.mover.hostId)
    if (!leadClient || !leadRelay || !moverRelay) {
      throw new Error('a team spans gateways only through a relay both gateways dial')
    }
    outcome = await acrossGateways(
      plan,
      client,
      leadClient,
      { hostId: lead.hostId, agentId: lead.agentId, gateway: leadRelay.gateway },
      moverRelay,
    )
  }
  if (outcome.committed !== 'yes') {
    return outcome
  }
  const unordered = [...(outcome.unordered ?? [])]
  for (const sibling of plan.siblings ?? []) {
    const done = await step(clientOf(sibling.hostId)?.updateAgent(sibling.agentId, { order: sibling.order }))
    if (!done.ok) {
      unordered.push({ hostId: sibling.hostId, agentId: sibling.agentId })
    }
  }
  return unordered.length ? { ...outcome, unordered } : outcome
}

async function sameGateway(move: TeamMovePlan, gateway: WorkerDeckClient, leadId: string): Promise<TeamMoveOutcome> {
  const order = orderOf(move)
  const crossOwner = move.crossOwner ? { crossOwner: true } : {}
  if (move.mover.agentId) {
    return settle(await step(gateway.updateAgent(move.mover.agentId, { lead: leadId, ...order, ...crossOwner })))
  }
  const adopted = await step(gateway.createAgent({ adopt: move.mover.sessionId, lead: leadId, ...crossOwner }))
  if (!adopted.ok || move.order === undefined) {
    return settle(adopted)
  }
  const agentId = adopted.response.agent.id
  const ordered = await step(gateway.updateAgent(agentId, order))
  return ordered.ok ? { committed: 'yes' } : { committed: 'yes', unordered: [{ hostId: move.mover.hostId, agentId }] }
}

async function acrossGateways(
  move: TeamMovePlan,
  gateway: WorkerDeckClient,
  leadGateway: WorkerDeckClient,
  target: { hostId: string; agentId: string; gateway: string },
  moverRelay: GatewayRelayMeta,
): Promise<TeamMoveOutcome> {
  const order = orderOf(move)
  let agentId = move.mover.agentId
  let adopted: TeamMoveOutcome['adopted']
  if (!agentId) {
    const created = await step(gateway.createAgent({ adopt: move.mover.sessionId }))
    if (!created.ok) {
      return settle(created)
    }
    agentId = created.response.agent.id
    adopted = { hostId: move.mover.hostId, agentId }
  }
  const kept = adopted ? { adopted } : {}
  const member = `${moverRelay.gateway}:${agentId}`
  const invited = await step(leadGateway.inviteRemoteMember(target.agentId, member, move.mover.owner))
  if (!invited.ok) {
    return { committed: 'no', error: invited.error, ...kept }
  }
  const entry = invited.response.agent.remoteMembers?.find((candidate) => candidate.agent === member)
  const invitation: TeamInvitation | undefined =
    entry?.state === 'invited' && entry.invite !== undefined
      ? { hostId: target.hostId, leadAgentId: target.agentId, member, invite: entry.invite, state: 'open' }
      : undefined
  const joined = await step(gateway.updateAgent(agentId, { lead: `${target.gateway}:${target.agentId}`, ...order }))
  if (joined.ok) {
    return { committed: 'yes', ...kept }
  }
  if (!invitation) {
    return { committed: joined.definite ? 'no' : 'unknown', error: joined.error, ...kept }
  }
  if (!joined.definite) {
    return { committed: 'unknown', error: joined.error, ...kept, invitation }
  }
  const withdrawn = await step(leadGateway.withdrawInvitation(target.agentId, member, invitation.invite))
  return { committed: 'no', error: joined.error, ...kept, invitation: { ...invitation, state: withdrawn.ok ? 'withdrawn' : 'open' } }
}

// The safe next action for an open invitation: conditional on its id, so a join that went through meanwhile stays.
export async function withdrawTeamInvitation(
  invitation: TeamInvitation,
  clientOf: (hostId: string) => WorkerDeckClient | undefined,
): Promise<void> {
  const client = clientOf(invitation.hostId)
  if (!client) {
    throw new Error('that gateway is not configured here')
  }
  await client.withdrawInvitation(invitation.leadAgentId, invitation.member, invitation.invite)
}

// The one sentence a host shows for a move that did not simply go through; undefined when there is nothing to say.
export function teamMoveMessage(outcome: TeamMoveOutcome): string | undefined {
  const parts: string[] = []
  if (outcome.committed === 'no') {
    parts.push(sentence(outcome.error ?? 'The move was refused'))
  } else if (outcome.committed === 'unknown') {
    parts.push(`The gateway did not answer, so the join may still go through${outcome.error ? ` (${outcome.error})` : ''}.`)
  }
  if (outcome.committed !== 'yes' && outcome.adopted) {
    parts.push('The session stays an agent.')
  }
  if (outcome.invitation?.state === 'withdrawn') {
    parts.push('The invitation was withdrawn.')
  } else if (outcome.invitation?.state === 'open') {
    parts.push('The invitation stays open for up to 10 minutes.')
  }
  if (outcome.unordered?.length) {
    const count = outcome.unordered.length
    parts.push(`The team order of ${count} agent${count === 1 ? '' : 's'} was not saved; drag again to reorder.`)
  }
  return parts.length ? parts.join(' ') : undefined
}

async function step(call: Promise<AgentResponse> | undefined): Promise<Step> {
  if (!call) {
    return { ok: false, definite: true, error: 'that gateway is not configured here' }
  }
  try {
    return { ok: true, response: await call }
  } catch (error) {
    const status = (error as { status?: unknown }).status
    return {
      ok: false,
      definite: typeof status === 'number' && status < 500,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function orderOf(move: TeamMovePlan): { order?: number } {
  return move.order === undefined ? {} : { order: move.order }
}

function settle(result: Step): TeamMoveOutcome {
  if (result.ok) {
    return { committed: 'yes' }
  }
  return { committed: result.definite ? 'no' : 'unknown', error: result.error }
}

function sentence(text: string): string {
  const trimmed = text.trim()
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capital) ? capital : `${capital}.`
}
