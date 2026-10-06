import {
  RELAY_GATEWAY_NAME,
  isShareLevel,
  parseRelayPeerId,
  qualifyId,
  type RelayAgentEntry,
  type RelaySessionEntry,
} from '@workerdeck/relay-client'

export const MAX_ACCEPTS = 32
const MAX_AGENT_NAME = 64

export type TeamNode = { gateway: string; owner: string; agent?: RelayAgentEntry }

export type AgentLookup = (qualifiedId: string) => TeamNode | undefined

// The relay stores every agent id qualified. An agent id naming another gateway is a forged claim,
// so the whole agent field is dropped; a lead or accepts entry may name another gateway by design.
export function sanitizeAgent(gateway: string, value: unknown): RelayAgentEntry | undefined {
  const raw = value as Partial<Record<keyof RelayAgentEntry, unknown>> | null
  if (typeof raw !== 'object' || raw === null || typeof raw.id !== 'string' || !raw.id || typeof raw.name !== 'string') {
    return undefined
  }
  const owned = parseRelayPeerId(raw.id)
  if (owned && owned.gateway !== gateway) {
    return undefined
  }
  const agent: RelayAgentEntry = { id: qualifyId(gateway, raw.id), name: raw.name.slice(0, MAX_AGENT_NAME) }
  if (typeof raw.lead === 'string' && raw.lead) {
    agent.lead = qualifyId(gateway, raw.lead)
  }
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) {
    agent.order = raw.order
  }
  if (Array.isArray(raw.accepts)) {
    agent.accepts = raw.accepts
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .slice(0, MAX_ACCEPTS)
      .map((id) => qualifyId(gateway, id))
  }
  if (isShareLevel(raw.share)) {
    agent.share = raw.share
  }
  return agent
}

export function sanitizeEntry(gateway: string, entry: RelaySessionEntry): RelaySessionEntry {
  const { agent, ...rest } = entry
  const clean = sanitizeAgent(gateway, agent)
  return clean ? { ...rest, agent: clean } : rest
}

function gatewayOf(qualifiedId: string): string | undefined {
  const at = qualifiedId.indexOf(':')
  const gateway = at > 0 ? qualifiedId.slice(0, at) : undefined
  return gateway && RELAY_GATEWAY_NAME.test(gateway) ? gateway : undefined
}

// A membership claim holds when the member's own gateway also holds the lead (it is authoritative
// for both), or when the lead's published entry accepts the member. A lead that publishes nothing
// validates nobody remote.
export function validLead(node: TeamNode, lookup: AgentLookup): string | undefined {
  const lead = node.agent?.lead
  if (!lead || !node.agent) {
    return undefined
  }
  if (gatewayOf(lead) === node.gateway) {
    return lead
  }
  return lookup(lead)?.agent?.accepts?.includes(node.agent.id) ? lead : undefined
}

export function teamRelated(a: TeamNode, b: TeamNode, lookup: AgentLookup): boolean {
  if (!a.agent || !b.agent) {
    return false
  }
  const aLead = validLead(a, lookup)
  const bLead = validLead(b, lookup)
  return bLead === a.agent.id || aLead === b.agent.id || (aLead !== undefined && aLead === bLead)
}

// Same owner: sessions outside teams see each other as the rules say, and a member sees only its
// lead and teammates. Different owners: only team rows, and an agent shared as `none` with nobody.
export function teamAllows(sender: TeamNode, target: TeamNode, lookup: AgentLookup): boolean {
  const related = teamRelated(sender, target, lookup)
  if (sender.owner === target.owner) {
    return related || (sender.agent?.lead === undefined && target.agent?.lead === undefined)
  }
  if (sender.agent?.share === 'none' || target.agent?.share === 'none') {
    return false
  }
  return related
}

// What a gateway of another owner may learn about a session: paths and profile names stay home.
export function projectForOtherOwner(entry: RelaySessionEntry): RelaySessionEntry {
  const { profile: _profile, permissionMode: _mode, project, ...rest } = entry
  return { ...rest, cwd: '', ...(project ? { project: { name: project.name, root: '' } } : {}) }
}
