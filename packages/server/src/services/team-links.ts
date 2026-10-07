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
import { isAgentRefusal, type AgentRefusal, type AgentService, type RemoteJoin } from './agents.ts'

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
  #timer: NodeJS.Timeout | undefined
  #reconciling: Promise<void> | undefined
  #stopped = false

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
    this.#stopped = false
    this.#timer = setInterval(() => void this.reconcile(), this.#reconcileMs)
    this.#timer.unref()
  }

  stop(): void {
    this.#stopped = true
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  // A commit the local graph no longer allows is refused here, so the lead's acceptance is withdrawn with a leave.
  async join(
    mover: StoredAgent,
    lead: string,
    commit: (joined: RemoteJoin) => Promise<StoredAgent | AgentRefusal>,
  ): Promise<StoredAgent | AgentRefusal> {
    const unavailable = this.#transport.ready()
    if (unavailable) {
      return { status: 409, error: unavailable }
    }
    const refused = await this.#agents.reserveJoin(mover, lead)
    if (refused) {
      return refused
    }
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
      const previous = this.#agents.get(mover.id)?.lead
      let stored: StoredAgent | AgentRefusal
      try {
        stored = await commit({
          lead,
          remoteLead: { name: result.leadName ?? lead, owner: this.#transport.owner(), state: 'joined', since: this.#now() },
        })
      } catch (error) {
        this.#notify('team.leave', mover.id, lead)
        throw error
      }
      if (isAgentRefusal(stored)) {
        this.#notify('team.leave', mover.id, lead)
        return stored
      }
      if (previous !== undefined && previous !== lead) {
        this.left(mover.id, previous)
      } else {
        this.#transport.nudge()
      }
      return stored
    } finally {
      this.#agents.releaseJoin(mover.id, lead)
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
    return this.#agents.patch(lead.id, (current) => {
      if (current.lead !== undefined) {
        return { status: 409, error: `${current.name} is a member of a team; teams are one level deep` }
      }
      if (this.#agents.joiningLead(current.id) !== undefined) {
        return { status: 409, error: `${current.name} is joining a team` }
      }
      const members = current.remoteMembers ?? []
      const existing = members.find((member) => member.agent === agent)
      if (existing?.state === 'accepted') {
        return current
      }
      if (!existing && members.length >= MAX_REMOTE_MEMBERS) {
        return { status: 409, error: `a team holds at most ${MAX_REMOTE_MEMBERS} members from other gateways` }
      }
      const at = this.#now()
      const invited: RemoteMember = { agent, owner: this.#transport.owner(), state: 'invited', at, expiresAt: at + this.#inviteTtlMs }
      return { ...current, remoteMembers: [...members.filter((member) => member.agent !== agent), invited] }
    })
  }

  async removeMember(lead: StoredAgent, agent: string): Promise<StoredAgent | AgentRefusal> {
    let accepted = false
    const saved = await this.#agents.patch(lead.id, (current) => {
      const members = current.remoteMembers ?? []
      const entry = members.find((member) => member.agent === agent)
      if (!entry) {
        return { status: 404, error: `no such member: ${agent}` }
      }
      accepted = entry.state === 'accepted'
      return { ...current, remoteMembers: members.filter((member) => member !== entry) }
    })
    if (isAgentRefusal(saved)) {
      return saved
    }
    if (accepted) {
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
        let changed = false
        await this.#agents.patch(to, (lead) => {
          const members = lead.remoteMembers ?? []
          changed = members.some((member) => member.agent === origin.agent)
          return changed ? { ...lead, remoteMembers: members.filter((member) => member.agent !== origin.agent) } : lead
        })
        if (changed) {
          this.#transport.nudge()
        }
        return { ok: true }
      }
      case 'team.release': {
        let changed = false
        await this.#agents.patch(to, (member) => {
          changed = member.lead === origin.agent
          if (!changed) {
            return member
          }
          const { lead: _lead, remoteLead: _remote, ...rest } = member
          return rest
        })
        if (changed) {
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
      const to = typeof edge.to === 'string' ? edge.to : ''
      const from = typeof edge.from === 'string' ? edge.from : ''
      if (parseRelayPeerId(from)?.gateway !== origin.gateway) {
        return { known: false }
      }
      if (this.#agents.joiningLead(to) === from) {
        return { known: true, name: this.#agents.get(to)?.name ?? this.#agents.joiningName(to) }
      }
      const agent = this.#agents.get(to)
      const known =
        agent !== undefined &&
        (agent.lead === from || (agent.remoteMembers ?? []).some((member) => member.agent === from && member.state === 'accepted'))
      return known ? { known, name: agent.name } : { known }
    })
  }

  // Never rejects: the timer and the relay's welcome both launch it without a handler.
  reconcile(): Promise<void> {
    this.#reconciling ??= this.#reconcileOnce()
      .catch((error: unknown) => {
        if (!this.#stopped) {
          this.#log(`teams: reconcile failed (${error instanceof Error ? error.message : String(error)})`)
        }
      })
      .finally(() => {
        this.#reconciling = undefined
      })
    return this.#reconciling
  }

  async #acceptJoin(origin: RelayTeamOrigin, to: string): Promise<TeamResult> {
    let changed = false
    const outcome = await this.#agents.patch(to, (lead) => {
      if (lead.lead !== undefined) {
        return { status: 409, error: `${lead.name} is a member of a team; teams are one level deep` }
      }
      if (this.#agents.joiningLead(lead.id) !== undefined) {
        return { status: 409, error: `${lead.name} is joining a team` }
      }
      const members = lead.remoteMembers ?? []
      const existing = members.find((member) => member.agent === origin.agent)
      if (existing?.state === 'accepted') {
        return lead
      }
      const sameOwner = origin.owner === this.#transport.owner()
      const invited = existing?.state === 'invited' && existing.owner === origin.owner && (existing.expiresAt ?? Infinity) > this.#now()
      if (!invited && !(sameOwner && this.#acceptFrom.has(origin.gateway))) {
        return { status: 409, error: `${lead.name} has not invited this agent` }
      }
      if (!existing && members.length >= MAX_REMOTE_MEMBERS) {
        return { status: 409, error: `a team holds at most ${MAX_REMOTE_MEMBERS} members from other gateways` }
      }
      changed = true
      const accepted: RemoteMember = { agent: origin.agent, name: origin.name, owner: origin.owner, state: 'accepted', at: this.#now() }
      return { ...lead, remoteMembers: [...members.filter((member) => member.agent !== origin.agent), accepted] }
    })
    if (isAgentRefusal(outcome)) {
      return outcome.status === 404 ? NO_SUCH_AGENT : { ok: false, reason: outcome.error }
    }
    if (changed) {
      this.#transport.nudge()
    }
    return { ok: true, leadName: outcome.name }
  }

  #notify(kind: 'team.leave' | 'team.release', from: string, to: string): void {
    this.#transport.team(kind, from, to).catch((error: unknown) => {
      this.#log(
        `teams: ${kind} to ${to} not delivered (${error instanceof Error ? error.message : String(error)}); reconcile will settle it`,
      )
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
      if (this.#stopped) {
        return
      }
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
        if (this.#stopped) {
          return
        }
        const answer = answers?.find((row) => row.from === edge.from && row.to === edge.to)
        await this.#settle(edge, answer)
      }
    }
  }

  // No answer (offline, timeout, a rule that denies) only marks the edge unreachable; `known: false` from the other
  // gateway itself is the one thing that dissolves it.
  async #settle(edge: Edge, answer: TeamStatusEdge | undefined): Promise<void> {
    const now = this.#now()
    let dissolved: string | undefined
    const outcome = await this.#agents.patch(edge.from, (agent) => {
      if (edge.side === 'member') {
        if (agent.lead !== edge.to || this.#agents.joiningLead(agent.id) !== undefined) {
          return agent
        }
        if (answer && !answer.known) {
          dissolved = `teams: ${agent.name} left ${agent.remoteLead?.name ?? edge.to}, which no longer lists it`
          const { lead: _lead, remoteLead: _remote, ...rest } = agent
          return rest
        }
        const current = agent.remoteLead ?? { name: edge.to, state: 'joined' as const, since: now }
        const state = answer ? 'joined' : 'unreachable'
        const name = answer?.name ?? current.name
        if (current.state === state && current.name === name) {
          return agent
        }
        return { ...agent, remoteLead: { ...current, name, state, since: current.state === state ? current.since : now } }
      }
      const members = agent.remoteMembers ?? []
      const entry = members.find((member) => member.agent === edge.to && member.state === 'accepted')
      if (!entry) {
        return agent
      }
      if (answer && !answer.known) {
        dissolved = ''
        return { ...agent, remoteMembers: members.filter((member) => member !== entry) }
      }
      const next: RemoteMember = { ...entry }
      if (answer) {
        delete next.unreachableSince
        next.name = answer.name ?? entry.name
      } else {
        next.unreachableSince = entry.unreachableSince ?? now
      }
      if (next.name === entry.name && next.unreachableSince === entry.unreachableSince) {
        return agent
      }
      return { ...agent, remoteMembers: members.map((member) => (member === entry ? next : member)) }
    })
    if (isAgentRefusal(outcome) || dissolved === undefined) {
      return
    }
    if (dissolved) {
      this.#log(dissolved)
    }
    this.#transport.nudge()
  }

  async #pruneInvites(): Promise<void> {
    for (const info of this.#agents.list()) {
      await this.#agents.patch(info.id, (agent) => {
        const now = this.#now()
        const members = agent.remoteMembers ?? []
        const kept = members.filter((member) => member.state !== 'invited' || (member.expiresAt ?? Infinity) > now)
        return kept.length === members.length ? agent : { ...agent, remoteMembers: kept }
      })
    }
  }
}
