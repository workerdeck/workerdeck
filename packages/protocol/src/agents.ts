import type { GatewayAgentDefaults, PermissionMode, ProfileInfo, SessionInfo } from './index.ts'

export type AgentRef = {
  id: string
  name: string
  avatar?: string
  lead?: string
  leadGateway?: string
  team?: string
  leads?: true
  // A top-level agent its owner shares with other owners' shared agents: a card in their lists and messages, no more.
  shared?: true
  order?: number
  // Which conversation the agent is on, from 1: each restart ("New conversation") starts the next one.
  conversation?: number
}

export type AgentConfig = {
  cwd?: string
  profile?: string
  model?: string
  reasoningEffort?: string
  permissionMode?: PermissionMode
  brief?: string
  agentContextReset?: boolean
  sleepAfterMs?: number
}

// `op` names the join this binding came from; `unconfirmed` is a half carried over from before operation ids, which
// restricts like a member but reaches nobody until the lead's gateway confirms it.
export type RemoteLead = {
  name: string
  owner?: string
  state: 'joined' | 'unreachable' | 'unconfirmed'
  since: number
  op?: string
}

export type RemoteMember = {
  agent: string
  name?: string
  owner?: string
  state: 'invited' | 'accepted' | 'unconfirmed'
  at: number
  expiresAt?: number
  unreachableSince?: number
  op?: string
  invite?: string
}

export const SHARINGS = ['private', 'shared'] as const
export type Sharing = (typeof SHARINGS)[number]

export function isSharing(value: unknown): value is Sharing {
  return value === 'private' || value === 'shared'
}

export type AgentInfo = {
  id: string
  name: string
  owner?: string
  // Stored at create, never re-resolved from a default; absent reads as private. Inert while the agent is a member.
  sharing?: Sharing
  createdAt: number
  updatedAt: number
  avatar?: string
  sessionId?: string
  pastSessions: string[]
  config: AgentConfig
  lead?: string
  order?: number
  remoteLead?: RemoteLead
  remoteMembers?: RemoteMember[]
}

export type InviteRemoteMemberRequest = { agent: string; owner?: string }

export type CreateAgentRequest = {
  name?: string
  config?: AgentConfig
  prompt?: string
  lead?: string
  adopt?: string
  owner?: string
  sharing?: Sharing
  // Confirms a join whose lead belongs to another owner on this gateway.
  crossOwner?: boolean
}

export type UpdateAgentRequest = {
  name?: string
  config?: AgentConfig
  lead?: string | null
  order?: number
  owner?: string
  sharing?: Sharing
  crossOwner?: boolean
}

export type RetireAgentRequest = { members?: 'release' | 'retire' }

export type AgentsResponse = { agents: AgentInfo[] }

export type AgentResponse = { agent: AgentInfo; session?: SessionInfo }

export const AGENT_SLEEP_AFTER_MS_DEFAULT = 15 * 60_000

export function agentRef(agent: AgentInfo, team: { leadName?: string; leadGateway?: string; leads?: boolean } = {}): AgentRef {
  const ref: AgentRef = { id: agent.id, name: agent.name }
  if (agent.avatar !== undefined) {
    ref.avatar = agent.avatar
  }
  if (agent.lead !== undefined) {
    ref.lead = agent.lead
    if (team.leadGateway !== undefined) {
      ref.leadGateway = team.leadGateway
    }
    if (team.leadName !== undefined) {
      ref.team = team.leadName
    }
  }
  if (team.leads) {
    ref.leads = true
  }
  if (agent.sharing === 'shared' && agent.lead === undefined) {
    ref.shared = true
  }
  if (agent.pastSessions.length > 0) {
    ref.conversation = agent.pastSessions.length + 1
  }
  if (agent.order !== undefined) {
    ref.order = agent.order
  }
  return ref
}

export function teamRole(agent: AgentRef | undefined): 'lead' | 'member' | undefined {
  return agent?.lead !== undefined ? 'member' : agent?.leads ? 'lead' : undefined
}

// The peers rule for teams: a member reaches its lead and teammates only, nobody outside a team reaches its members,
// and everything top-level reaches everything top-level. Sessions with no agent are top-level.
export function teamReaches(from: AgentRef | undefined, to: AgentRef | undefined): boolean {
  if (to?.lead !== undefined) {
    return from !== undefined && (from.id === to.lead || from.lead === to.lead)
  }
  if (from?.lead !== undefined) {
    return to !== undefined && to.id === from.lead
  }
  return true
}

export const OWNER_NAME = /^[a-z0-9-]{1,32}$/

export function isOwnerName(value: unknown): value is string {
  return typeof value === 'string' && OWNER_NAME.test(value)
}

// Lead and member, or two members of one lead. Ids must be comparable (qualified, or all local).
export function teamRelated(a: AgentRef | undefined, b: AgentRef | undefined): boolean {
  if (!a || !b) {
    return false
  }
  return a.lead === b.id || b.lead === a.id || (a.lead !== undefined && a.lead === b.lead)
}

export type PeerParty = { owner?: string; agent?: AgentRef; permissionMode?: string }

export type PeerOps = { list: boolean; send: boolean; peek: boolean }

const NO_OPS: PeerOps = { list: false, send: false, peek: false }
const ALL_OPS: PeerOps = { list: true, send: true, peek: true }

function sharedLead(agent: AgentRef | undefined): boolean {
  return agent?.shared === true && agent.lead === undefined
}

// A session that runs tools without asking takes nothing from another owner's agents.
function unprompted(party: PeerParty): boolean {
  return party.permissionMode === 'bypassPermissions' || party.permissionMode === 'dontAsk'
}

// The peers rule with owners and sharing, one matrix for local and relayed peers. The team rule always holds. The
// same owner reaches everything it does. Different owners reach each other through a team (peek as the rules allow),
// or as two shared top-level agents (a card and messages, never a peek). Either way nothing is sent to a session of
// another owner that runs without prompts. On a gateway with several owners a missing owner matches nobody.
export function peerOps(from: PeerParty, to: PeerParty, multiOwner: boolean): PeerOps {
  if (!teamReaches(from.agent, to.agent)) {
    return NO_OPS
  }
  if (from.owner === to.owner && (from.owner !== undefined || !multiOwner)) {
    return ALL_OPS
  }
  if (teamRelated(from.agent, to.agent)) {
    return { list: true, send: !unprompted(to), peek: true }
  }
  const owned = from.owner !== undefined && to.owner !== undefined
  if (owned && sharedLead(from.agent) && sharedLead(to.agent) && !unprompted(to)) {
    return { list: true, send: true, peek: false }
  }
  return NO_OPS
}

export function peerReaches(from: PeerParty, to: PeerParty, multiOwner: boolean): boolean {
  return peerOps(from, to, multiOwner).list
}

// Qualifies an agent ref's ids with its gateway, so local and remote refs compare in `teamReaches`. A qualified id
// (`gateway:agentId`) is left as it is; local agent ids are UUIDs and never contain a colon.
export function qualifyAgent(ref: AgentRef | undefined, gateway: string): AgentRef | undefined {
  if (ref === undefined) {
    return undefined
  }
  const qualify = (id: string) => (id.includes(':') ? id : `${gateway}:${id}`)
  return { ...ref, id: qualify(ref.id), ...(ref.lead !== undefined ? { lead: qualify(ref.lead) } : {}) }
}

export const PROJECT_ACCENTS = ['#497eae', '#8a6bb8', '#3f8f6b', '#b0794a', '#a85a6e', '#4f8f96', '#7c8a3f', '#6b72b8'] as const

// A stable colour per project key (a host and root, or any string), the same on every client and the gateway.
export function projectAccent(key: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193)
  }
  return PROJECT_ACCENTS[(hash >>> 0) % PROJECT_ACCENTS.length]!
}

// What the gateway will stamp on a new agent that asks for nothing: the profile's choice, then the gateway's.
export function newAgentOwner(defaults: GatewayAgentDefaults | undefined, profile: ProfileInfo | undefined): string | undefined {
  return profile?.owner ?? defaults?.owner
}

export function newAgentSharing(defaults: GatewayAgentDefaults | undefined, profile: ProfileInfo | undefined): Sharing {
  if (defaults?.allowShared === false) {
    return 'private'
  }
  return (profile?.defaults?.sharing ?? defaults?.sharing) === 'shared' ? 'shared' : 'private'
}
