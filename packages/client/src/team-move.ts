import type { GatewayRelayMeta } from '@workerdeck/protocol'
import type { WorkerDeckClient } from './index.ts'

// A drop in a session list, as the gateways see it. `lead: null` leaves the team; a mover without an agent is
// adopted first. `hostId` is the client's own name for a gateway, never its relay name.
export type TeamMovePlan = {
  mover: { hostId: string; sessionId: string; agentId?: string }
  lead: { hostId: string; agentId: string } | null
  order?: number
  siblings?: Array<{ hostId: string; agentId: string; order: number }>
}

// Across gateways a join takes two operator calls, one per side: the lead's gateway invites, then the mover's gateway
// joins through the relay. Holding a key for both gateways is the consent.
export async function runTeamMove(
  plan: TeamMovePlan,
  clientOf: (hostId: string) => WorkerDeckClient | undefined,
  relayOf: (hostId: string) => GatewayRelayMeta | undefined = () => undefined,
): Promise<void> {
  const client = clientOf(plan.mover.hostId)
  if (!client) {
    return
  }
  const lead = plan.lead
  const order = plan.order === undefined ? {} : { order: plan.order }
  if (!lead) {
    if (plan.mover.agentId) {
      await client.updateAgent(plan.mover.agentId, { lead: null })
    }
  } else if (lead.hostId === plan.mover.hostId) {
    if (plan.mover.agentId) {
      await client.updateAgent(plan.mover.agentId, { lead: lead.agentId, ...order })
    } else {
      const adopted = await client.createAgent({ adopt: plan.mover.sessionId, lead: lead.agentId })
      if (plan.order !== undefined) {
        await client.updateAgent(adopted.agent.id, order)
      }
    }
  } else {
    const leadClient = clientOf(lead.hostId)
    const leadRelay = relayOf(lead.hostId)
    const moverRelay = relayOf(plan.mover.hostId)
    if (!leadClient || !leadRelay || !moverRelay) {
      throw new Error('a team spans gateways only through a relay both gateways dial')
    }
    const agentId = plan.mover.agentId ?? (await client.createAgent({ adopt: plan.mover.sessionId })).agent.id
    await leadClient.inviteRemoteMember(lead.agentId, `${moverRelay.gateway}:${agentId}`)
    await client.updateAgent(agentId, { lead: `${leadRelay.gateway}:${lead.agentId}`, ...order })
  }
  for (const sibling of plan.siblings ?? []) {
    await clientOf(sibling.hostId)?.updateAgent(sibling.agentId, { order: sibling.order })
  }
}
