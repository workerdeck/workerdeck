import type { RemoteMember } from '@workerdeck/protocol'
import {
  parseRelayPeerId,
  type RelayTeamOrigin,
  type TeamEdge,
  type TeamFrameKind,
  type TeamResult,
  type TeamStatusEdge,
} from '@workerdeck/relay-client'
import type { StoredAgent } from './agent-store.ts'
import type { AgentRefusal, AgentService, RemoteJoin } from './agents.ts'

export type TeamTransport = {
  gateway: string
  ready(): string | undefined
  owner(): string | undefined
  team(kind: TeamFrameKind, from: string, to: string): Promise<TeamResult>
  teamStatus(gateway: string, edges: TeamEdge[]): Promise<TeamStatusEdge[]>
  nudge(): void
}

export type TeamLinksOptions = {
  agents: AgentService
  transport: TeamTransport
  // Gateways of the same owner whose agents may join a lead here without a per-join invitation.
  acceptFrom?: readonly string[]
  reconcileMs?: number
  inviteTtlMs?: number
  now?: () => number
  log?: (message: string) => void
}

type Edge = { gateway: string; from: string; to: string; side: 'lead' | 'member' }

export const MAX_REMOTE_MEMBERS = 32
const RECONCILE_MS = 15_000
const INVITE_TTL_MS = 10 * 60_000
const NO_SUCH_AGENT: TeamResult = { ok: false, reason: 'no such agent' }

// The cross-gateway half of teams. Each gateway is authoritative for its own agents: an edge exists when the member's
// gateway holds `lead` and the lead's gateway holds an accepted `remoteMembers` entry, and only an authoritative answer
// from the other gateway removes one.
export class TeamLinks {
  #agents: AgentService
  #transport: TeamTransport
  #acceptFrom: ReadonlySet<string>
  #reconcileMs: number
  #inviteTtlMs: number
  #now: () => number
  #log: (message: string) => void
  #joining = new Map<string, string>()
  #timer: NodeJS.Timeout | undefined
  #reconciling: Promise<void> | undefined

  constructor(options: TeamLinksOptions) {
    this.#agents = options.agents
    this.#transport = options.transport
    this.#acceptFrom = new Set(options.acceptFrom ?? [])
    this.#reconcileMs = options.reconcileMs ?? RECONCILE_MS
    this.#inviteTtlMs = options.inviteTtlMs ?? INVITE_TTL_MS
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
  }

  start(): void {
    this.stop()
    this.#timer = setInterval(() => void this.reconcile(), this.#reconcileMs)
    this.#timer.unref()
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  // Runs the join handshake and hands the lead fields to `commit` while the agent still counts as joining, so a
  // reconcile from the lead's gateway that lands before the write is not answered "unknown".
  async join(mover: StoredAgent, lead: string, commit: (joined: RemoteJoin) => Promise<StoredAgent>): Promise<StoredAgent | AgentRefusal> {
    const refused = this.#agents.leadRefusal(mover, lead)
    if (refused) {
      return refused
    }
    if (this.#joining.has(mover.id)) {
      return { status: 409, error: `${mover.name} is already joining a team` }
    }
    const unavailable = this.#transport.ready()
    if (unavailable) {
      return { status: 409, error: unavailable }
    }
    this.#joining.set(mover.id, lead)
    try {
      let result: TeamResult
      try {
        result = await this.#transport.team('team.join', mover.id, lead)
      } catch {
        return { status: 409, error: 'remote gateways are unavailable right now; try again later' }
      }
      if (!result.ok) {
        return { status: 409, error: result.reason }
      }
      const previous = mover.lead
      const stored = await commit({
        lead,
        remoteLead: { name: result.leadName ?? lead, owner: this.#transport.owner(), state: 'joined', since: this.#now() },
      })
      if (previous !== undefined && previous !== lead) {
        this.#notify('team.leave', mover.id, previous)
      }
      this.#transport.nudge()
      return stored
    } finally {
      this.#joining.delete(mover.id)
    }
  }

  // Leaving never needs the lead online: the local half goes at once, and the lead's gateway drops its entry on the
  // frame or, failing that, on its next reconcile.
  left(agentId: string, lead: string | undefined): void {
    if (this.#agents.remoteGateway(lead)) {
      this.#notify('team.leave', agentId, lead!)
    }
    this.#transport.nudge()
  }

  async invite(lead: StoredAgent, agent: string): Promise<StoredAgent | AgentRefusal> {
    const target = parseRelayPeerId(agent)
    if (!target || !this.#agents.remoteGateway(agent)) {
      return { status: 400, error: 'agent must be an agent id on another gateway (gateway:agentId)' }
    }
    if (lead.lead !== undefined) {
      return { status: 409, error: `${lead.name} is a member of a team; teams are one level deep` }
    }
    if (this.#joining.has(lead.id)) {
      return { status: 409, error: `${lead.name} is joining a team` }
    }
    const members = lead.remoteMembers ?? []
    const existing = members.find((member) => member.agent === agent)
    if (existing?.state === 'accepted') {
      return lead
    }
    if (!existing && members.length >= MAX_REMOTE_MEMBERS) {
      return { status: 409, error: `a team holds at most ${MAX_REMOTE_MEMBERS} members from other gateways` }
    }
    const at = this.#now()
    const invited: RemoteMember = { agent, owner: this.#transport.owner(), state: 'invited', at, expiresAt: at + this.#inviteTtlMs }
    return this.#agents.save({ ...lead, remoteMembers: [...members.filter((member) => member.agent !== agent), invited] })
  }

  async removeMember(lead: StoredAgent, agent: string): Promise<StoredAgent | AgentRefusal> {
    const members = lead.remoteMembers ?? []
    const entry = members.find((member) => member.agent === agent)
    if (!entry) {
      return { status: 404, error: `no such member: ${agent}` }
    }
    const saved = await this.#agents.save({ ...lead, remoteMembers: members.filter((member) => member !== entry) })
    if (entry.state === 'accepted') {
      this.#notify('team.release', lead.id, agent)
    }
    this.#transport.nudge()
    return saved
  }

  // Remote members are released, never retired: no frame deletes an agent on another gateway.
  retiring(agent: StoredAgent): void {
    for (const member of agent.remoteMembers ?? []) {
      if (member.state === 'accepted') {
        this.#notify('team.release', agent.id, member.agent)
      }
    }
    this.left(agent.id, agent.lead)
  }

  async inbound(kind: TeamFrameKind, origin: RelayTeamOrigin, to: string): Promise<TeamResult> {
    if (parseRelayPeerId(origin.agent)?.gateway !== origin.gateway) {
      return NO_SUCH_AGENT
    }
    switch (kind) {
      case 'team.join': {
        return this.#acceptJoin(origin, to)
      }
      case 'team.leave': {
        const lead = this.#agents.get(to)
        const members = lead?.remoteMembers ?? []
        if (lead && members.some((member) => member.agent === origin.agent)) {
          await this.#agents.save({ ...lead, remoteMembers: members.filter((member) => member.agent !== origin.agent) })
          this.#transport.nudge()
        }
        return { ok: true }
      }
      case 'team.release': {
        const member = this.#agents.get(to)
        if (member && member.lead === origin.agent) {
          const { lead: _lead, remoteLead: _remote, ...rest } = member
          await this.#agents.save(rest)
          this.#transport.nudge()
        }
        return { ok: true }
      }
      default: {
        return NO_SUCH_AGENT
      }
    }
  }

  async inboundStatus(origin: { gateway: string }, edges: TeamEdge[]): Promise<Array<Omit<TeamStatusEdge, 'from' | 'to'>>> {
    return edges.map((edge) => {
      const agent = typeof edge.to === 'string' ? this.#agents.get(edge.to) : undefined
      const from = typeof edge.from === 'string' ? edge.from : ''
      if (!agent || parseRelayPeerId(from)?.gateway !== origin.gateway) {
        return { known: false }
      }
      const known =
        agent.lead === from ||
        this.#joining.get(agent.id) === from ||
        (agent.remoteMembers ?? []).some((member) => member.agent === from && member.state === 'accepted')
      return known ? { known, name: agent.name } : { known }
    })
  }

  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcileOnce().finally(() => {
      this.#reconciling = undefined
    })
    return this.#reconciling
  }

  async #acceptJoin(origin: RelayTeamOrigin, to: string): Promise<TeamResult> {
    const lead = this.#agents.get(to)
    if (!lead) {
      return NO_SUCH_AGENT
    }
    if (lead.lead !== undefined) {
      return { ok: false, reason: `${lead.name} is a member of a team; teams are one level deep` }
    }
    if (this.#joining.has(lead.id)) {
      return { ok: false, reason: `${lead.name} is joining a team` }
    }
    const members = lead.remoteMembers ?? []
    const existing = members.find((member) => member.agent === origin.agent)
    if (existing?.state === 'accepted') {
      return { ok: true, leadName: lead.name }
    }
    const sameOwner = origin.owner === this.#transport.owner()
    const invited =
      existing?.state === 'invited' && existing.owner === origin.owner && (existing.expiresAt ?? Infinity) > this.#now()
    if (!invited && !(sameOwner && this.#acceptFrom.has(origin.gateway))) {
      return { ok: false, reason: `${lead.name} has not invited this agent` }
    }
    if (!existing && members.length >= MAX_REMOTE_MEMBERS) {
      return { ok: false, reason: `a team holds at most ${MAX_REMOTE_MEMBERS} members from other gateways` }
    }
    const accepted: RemoteMember = { agent: origin.agent, name: origin.name, owner: origin.owner, state: 'accepted', at: this.#now() }
    await this.#agents.save({ ...lead, remoteMembers: [...members.filter((member) => member.agent !== origin.agent), accepted] })
    this.#transport.nudge()
    return { ok: true, leadName: lead.name }
  }

  #notify(kind: 'team.leave' | 'team.release', from: string, to: string): void {
    this.#transport.team(kind, from, to).catch((error: unknown) => {
      this.#log(`teams: ${kind} to ${to} not delivered (${error instanceof Error ? error.message : String(error)}); reconcile will settle it`)
    })
  }

  #edges(): Edge[] {
    const edges: Edge[] = []
    for (const info of this.#agents.list()) {
      const agent = this.#agents.get(info.id)!
      const leadGateway = this.#agents.remoteGateway(agent.lead)
      if (leadGateway) {
        edges.push({ gateway: leadGateway, from: agent.id, to: agent.lead!, side: 'member' })
      }
      for (const member of agent.remoteMembers ?? []) {
        const gateway = member.state === 'accepted' ? parseRelayPeerId(member.agent)?.gateway : undefined
        if (gateway) {
          edges.push({ gateway, from: agent.id, to: member.agent, side: 'lead' })
        }
      }
    }
    return edges
  }

  async #reconcileOnce(): Promise<void> {
    await this.#pruneInvites()
    const byGateway = new Map<string, Edge[]>()
    for (const edge of this.#edges()) {
      byGateway.set(edge.gateway, [...(byGateway.get(edge.gateway) ?? []), edge])
    }
    const offline = this.#transport.ready() !== undefined
    for (const [gateway, edges] of byGateway) {
      let answers: TeamStatusEdge[] | undefined
      if (!offline) {
        try {
          answers = await this.#transport.teamStatus(
            gateway,
            edges.map(({ from, to }) => ({ from, to })),
          )
        } catch {
          answers = undefined
        }
      }
      for (const edge of edges) {
        const answer = answers?.find((row) => row.from === edge.from && row.to === edge.to)
        await this.#settle(edge, answer)
      }
    }
  }

  // No answer (offline, timeout, a rule that denies) only marks the edge unreachable; `known: false` from the other
  // gateway itself is the one thing that dissolves it.
  async #settle(edge: Edge, answer: TeamStatusEdge | undefined): Promise<void> {
    const agent = this.#agents.get(edge.from)
    if (!agent) {
      return
    }
    const now = this.#now()
    if (edge.side === 'member') {
      if (agent.lead !== edge.to || this.#joining.has(agent.id)) {
        return
      }
      if (answer && !answer.known) {
        const { lead: _lead, remoteLead: _remote, ...rest } = agent
        await this.#agents.save(rest)
        this.#log(`teams: ${agent.name} left ${agent.remoteLead?.name ?? edge.to}, which no longer lists it`)
        this.#transport.nudge()
        return
      }
      const current = agent.remoteLead ?? { name: edge.to, state: 'joined' as const, since: now }
      const state = answer ? 'joined' : 'unreachable'
      const name = answer?.name ?? current.name
      if (current.state !== state || current.name !== name) {
        await this.#agents.save({ ...agent, remoteLead: { ...current, name, state, since: current.state === state ? current.since : now } })
      }
      return
    }
    const members = agent.remoteMembers ?? []
    const entry = members.find((member) => member.agent === edge.to && member.state === 'accepted')
    if (!entry) {
      return
    }
    if (answer && !answer.known) {
      await this.#agents.save({ ...agent, remoteMembers: members.filter((member) => member !== entry) })
      this.#transport.nudge()
      return
    }
    const next: RemoteMember = { ...entry }
    if (answer) {
      delete next.unreachableSince
      next.name = answer.name ?? entry.name
    } else {
      next.unreachableSince = entry.unreachableSince ?? now
    }
    if (next.name !== entry.name || next.unreachableSince !== entry.unreachableSince) {
      await this.#agents.save({ ...agent, remoteMembers: members.map((member) => (member === entry ? next : member)) })
    }
  }

  async #pruneInvites(): Promise<void> {
    const now = this.#now()
    for (const info of this.#agents.list()) {
      const agent = this.#agents.get(info.id)!
      const members = agent.remoteMembers ?? []
      const kept = members.filter((member) => member.state !== 'invited' || (member.expiresAt ?? Infinity) > now)
      if (kept.length !== members.length) {
        await this.#agents.save({ ...agent, remoteMembers: kept })
      }
    }
  }
}
