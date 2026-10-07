import { randomUUID } from 'node:crypto'
import type { RemoteMember } from '@workerdeck/protocol'
import {
  parseRelayPeerId,
  readTeamOp,
  type InboundTeamStatusAnswer,
  type RelayTeamOrigin,
  type TeamEdge,
  type TeamFrameKind,
  type TeamResult,
  type TeamRoster,
  type TeamSeen,
  type TeamStatusAnswer,
  type TeamStatusBody,
  type TeamStatusEdge,
} from '@workerdeck/relay-client'
import type { StoredAgent } from './agent-store.ts'
import { isAgentRefusal, type AgentRefusal, type AgentService, type RemoteJoin } from './agents.ts'

export type TeamTransport = {
  gateway: string
  ready(): string | undefined
  owner(): string | undefined
  team(kind: TeamFrameKind, from: string, to: string, op?: string): Promise<TeamResult>
  teamStatus(gateway: string, body: TeamStatusBody): Promise<TeamStatusAnswer>
  nudge(): void
}

export type TeamLinksOptions = {
  agents: AgentService
  transport: TeamTransport
  // Gateways of the same owner whose agents may join a lead here without a per-join invitation.
  acceptFrom?: readonly string[]
  reconcileMs?: number
  inviteTtlMs?: number
  // How long a lead's roster authorizes teammates on third gateways after its gateway last sent it.
  rosterFreshMs?: number
  // The delay before a changed roster is sent, so a burst of writes goes out once.
  soonMs?: number
  now?: () => number
  log?: (message: string) => void
}

type Edge = { gateway: string; from: string; to: string; op: string; side: 'lead' | 'member' | 'joining' }

type StatusRow = InboundTeamStatusAnswer['edges'][number]

type CachedRoster = { epoch: string; rev: number; members: ReadonlySet<string>; confirmedAt: number; replaced: Set<string> }

export const MAX_REMOTE_MEMBERS = 32
const RECONCILE_MS = 15_000
const INVITE_TTL_MS = 10 * 60_000
const SOON_MS = 1_000
const NO_SUCH_AGENT: TeamResult = { ok: false, reason: 'no such agent' }

// The cross-gateway half of teams. The lead's gateway owns the roster, the member's gateway owns the member's consent:
// an edge exists when both hold it under the same join op, and only an authoritative answer from the other gateway
// removes one. Rosters of remote leads are cached here, in memory, to vouch for teammates on third gateways.
export class TeamLinks {
  #agents: AgentService
  #transport: TeamTransport
  #acceptFrom: ReadonlySet<string>
  #reconcileMs: number
  #inviteTtlMs: number
  #rosterFreshMs: number
  #soonMs: number
  #now: () => number
  #log: (message: string) => void
  #timer: NodeJS.Timeout | undefined
  #soon: NodeJS.Timeout | undefined
  #unsubscribe: (() => void) | undefined
  #reconciling: Promise<void> | undefined
  #again = false
  #stopped = false
  #rosters = new Map<string, CachedRoster>()

  constructor(options: TeamLinksOptions) {
    this.#agents = options.agents
    this.#transport = options.transport
    this.#acceptFrom = new Set(options.acceptFrom ?? [])
    this.#reconcileMs = options.reconcileMs ?? RECONCILE_MS
    this.#inviteTtlMs = options.inviteTtlMs ?? INVITE_TTL_MS
    this.#rosterFreshMs = options.rosterFreshMs ?? 4 * this.#reconcileMs
    this.#soonMs = options.soonMs ?? SOON_MS
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? (() => {})
    this.#agents.useRosters((lead, member) => this.#vouch(lead, member))
  }

  start(): void {
    this.stop()
    this.#stopped = false
    this.#timer = setInterval(() => void this.reconcile(), this.#reconcileMs)
    this.#timer.unref()
    this.#unsubscribe = this.#agents.onWrite(() => this.#rosterMoved())
  }

  stop(): void {
    this.#stopped = true
    clearInterval(this.#timer)
    clearTimeout(this.#soon)
    this.#timer = undefined
    this.#soon = undefined
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
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
    const reserved = await this.#agents.reserveJoin(mover, lead)
    if (isAgentRefusal(reserved)) {
      return reserved
    }
    const { op } = reserved
    try {
      let result: TeamResult
      try {
        result = await this.#transport.team('team.join', mover.id, lead, op)
      } catch {
        this.#notify('team.leave', mover.id, lead, op)
        return { status: 409, error: 'remote gateways are unavailable right now; try again later' }
      }
      if (!result.ok) {
        return { status: 409, error: result.reason }
      }
      const previous = this.#agents.get(mover.id)
      let stored: StoredAgent | AgentRefusal
      try {
        stored = await commit(this.#joined(lead, op, result.leadName))
      } catch (error) {
        this.#notify('team.leave', mover.id, lead, op)
        throw error
      }
      if (isAgentRefusal(stored)) {
        this.#notify('team.leave', mover.id, lead, op)
        return stored
      }
      this.#movedOff(mover.id, previous, lead)
      return stored
    } finally {
      await this.#agents.releaseJoin(mover.id, op)
    }
  }

  // Leaving never needs the lead online: the local half goes at once, and the lead's gateway drops its entry on the
  // frame or, failing that, on its next reconcile, where this gateway no longer holds the op.
  left(agentId: string, lead: string | undefined, op: string | undefined): void {
    if (this.#agents.remoteGateway(lead) && op !== undefined) {
      this.#notify('team.leave', agentId, lead!, op)
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
      if (existing?.state === 'accepted' || existing?.state === 'unconfirmed') {
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
    let op: string | undefined
    const saved = await this.#agents.patch(lead.id, (current) => {
      const members = current.remoteMembers ?? []
      const entry = members.find((member) => member.agent === agent)
      if (!entry) {
        return { status: 404, error: `no such member: ${agent}` }
      }
      op = entry.state === 'invited' ? undefined : entry.op
      return { ...current, remoteMembers: members.filter((member) => member !== entry) }
    })
    if (isAgentRefusal(saved)) {
      return saved
    }
    if (op !== undefined) {
      this.#notify('team.release', lead.id, agent, op)
    }
    this.#transport.nudge()
    return saved
  }

  // Remote members are released, never retired: no frame deletes an agent on another gateway.
  retiring(agent: StoredAgent): void {
    for (const member of agent.remoteMembers ?? []) {
      if (member.state !== 'invited' && member.op !== undefined) {
        this.#notify('team.release', agent.id, member.agent, member.op)
      }
    }
    if (agent.pendingJoin) {
      this.#notify('team.leave', agent.id, agent.pendingJoin.lead, agent.pendingJoin.op)
    }
    this.left(agent.id, agent.lead, agent.remoteLead?.op)
  }

  async inbound(kind: TeamFrameKind, origin: RelayTeamOrigin, to: string, op?: string): Promise<TeamResult> {
    if (!this.#agents.hydrated()) {
      return { ok: false, reason: 'that gateway is starting; try again shortly' }
    }
    if (parseRelayPeerId(origin.agent)?.gateway !== origin.gateway) {
      return NO_SUCH_AGENT
    }
    switch (kind) {
      case 'team.join': {
        return op === undefined
          ? { ok: false, reason: 'that gateway needs a newer WorkerDeck to join this team' }
          : this.#acceptJoin(origin, to, op)
      }
      case 'team.leave': {
        let changed = false
        await this.#agents.patch(to, (lead) => {
          const members = lead.remoteMembers ?? []
          const kept = members.filter((member) => member.agent !== origin.agent || member.state === 'invited' || member.op !== op)
          changed = kept.length !== members.length
          return changed ? { ...lead, remoteMembers: kept } : lead
        })
        if (changed) {
          this.#transport.nudge()
        }
        return { ok: true }
      }
      case 'team.release': {
        let changed = false
        await this.#agents.patch(to, (member) => {
          changed = member.lead === origin.agent && member.remoteLead?.op === op
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

  // The seen revisions go first, so a lead that fell behind answers with its new epoch in this same exchange.
  async inboundStatus(origin: { gateway: string }, body: TeamStatusBody): Promise<InboundTeamStatusAnswer> {
    if (!this.#agents.hydrated()) {
      return { edges: body.edges.map(() => ({})) }
    }
    for (const seen of body.seen ?? []) {
      await this.#seen(seen, origin.gateway)
    }
    for (const roster of body.rosters ?? []) {
      this.#take(roster, origin.gateway)
    }
    const edges: StatusRow[] = []
    for (const edge of body.edges) {
      edges.push(await this.#answer(origin.gateway, edge))
    }
    const rosters = await this.#rostersFor(origin.gateway)
    const seen = this.#seenFor(origin.gateway)
    return { edges, ...(rosters.length > 0 ? { rosters } : {}), ...(seen.length > 0 ? { seen } : {}) }
  }

  // Never rejects: the timer and the relay's welcome both launch it without a handler. A call during a pass runs one
  // more pass after it, so a change made mid-pass is not left for the timer.
  reconcile(): Promise<void> {
    if (this.#reconciling) {
      this.#again = true
      return this.#reconciling
    }
    this.#reconciling = this.#reconcileOnce()
      .catch((error: unknown) => {
        if (!this.#stopped) {
          this.#log(`teams: reconcile failed (${error instanceof Error ? error.message : String(error)})`)
        }
      })
      .finally(() => {
        this.#reconciling = undefined
        if (this.#again && !this.#stopped) {
          this.#again = false
          this.#later()
        }
      })
    return this.#reconciling
  }

  async #acceptJoin(origin: RelayTeamOrigin, to: string, op: string): Promise<TeamResult> {
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
      if (existing?.state === 'accepted' && existing.op === op) {
        return lead
      }
      // A member already accepted may join again under a new op: its gateway owns its consent, the lead already gave its.
      const member = existing?.state === 'accepted' || existing?.state === 'unconfirmed'
      const sameOwner = origin.owner === this.#transport.owner()
      const invited = existing?.state === 'invited' && existing.owner === origin.owner && (existing.expiresAt ?? Infinity) > this.#now()
      if (!member && !invited && !(sameOwner && this.#acceptFrom.has(origin.gateway))) {
        return { status: 409, error: `${lead.name} has not invited this agent` }
      }
      if (!existing && members.length >= MAX_REMOTE_MEMBERS) {
        return { status: 409, error: `a team holds at most ${MAX_REMOTE_MEMBERS} members from other gateways` }
      }
      changed = true
      const accepted: RemoteMember = { agent: origin.agent, name: origin.name, owner: origin.owner, state: 'accepted', at: this.#now(), op }
      return { ...lead, remoteMembers: [...members.filter((entry) => entry.agent !== origin.agent), accepted] }
    })
    if (isAgentRefusal(outcome)) {
      return outcome.status === 404 ? NO_SUCH_AGENT : { ok: false, reason: outcome.error }
    }
    if (changed) {
      this.#transport.nudge()
    }
    return { ok: true, leadName: outcome.name }
  }

  // Known means this gateway holds the edge under the asked op; holding it unconfirmed, it is confirmed by the asking.
  async #answer(gateway: string, edge: TeamEdge): Promise<StatusRow> {
    const to = typeof edge.to === 'string' ? edge.to : ''
    const from = typeof edge.from === 'string' ? edge.from : ''
    const op = readTeamOp(edge.op)
    if (parseRelayPeerId(from)?.gateway !== gateway || op === undefined) {
      return { known: false }
    }
    if (this.#agents.frozen(to)) {
      return {}
    }
    if (this.#agents.joiningLead(to) === from && this.#agents.joiningOp(to) === op) {
      return { known: true, name: this.#agents.get(to)?.name ?? this.#agents.joiningName(to) }
    }
    const agent = this.#agents.get(to)
    if (!agent) {
      return { known: false }
    }
    if (agent.lead === from && agent.remoteLead?.op === op && this.#eligible(agent, 'member')) {
      if (agent.remoteLead.state === 'unconfirmed') {
        await this.#confirm(to, 'member', from, op)
      }
      return { known: true, name: agent.name }
    }
    const entry = (agent.remoteMembers ?? []).find((member) => member.agent === from && member.op === op && member.state !== 'invited')
    if (entry && this.#eligible(agent, 'lead')) {
      if (entry.state === 'unconfirmed') {
        await this.#confirm(to, 'lead', from, op)
      }
      return { known: true, name: agent.name }
    }
    return { known: false }
  }

  async #confirm(id: string, side: 'lead' | 'member', other: string, op: string): Promise<void> {
    const now = this.#now()
    const outcome = await this.#agents.patch(id, (agent) => {
      if (side === 'member') {
        return agent.lead === other && agent.remoteLead?.op === op && agent.remoteLead.state === 'unconfirmed'
          ? { ...agent, remoteLead: { ...agent.remoteLead, state: 'joined', since: now } }
          : agent
      }
      const members = agent.remoteMembers ?? []
      const entry = members.find((member) => member.agent === other && member.op === op && member.state === 'unconfirmed')
      return entry
        ? { ...agent, remoteMembers: members.map((member) => (member === entry ? { ...entry, state: 'accepted' } : member)) }
        : agent
    })
    if (!isAgentRefusal(outcome)) {
      this.#log(`teams: confirmed the edge between ${outcome.name} and ${other}`)
      this.#transport.nudge()
    }
  }

  #joined(lead: string, op: string, leadName: string | undefined): RemoteJoin {
    return { lead, remoteLead: { name: leadName ?? lead, owner: this.#transport.owner(), state: 'joined', since: this.#now(), op } }
  }

  #movedOff(id: string, previous: StoredAgent | undefined, lead: string): void {
    if (previous?.lead !== undefined && previous.lead !== lead) {
      this.left(id, previous.lead, previous.remoteLead?.op)
    } else {
      this.#transport.nudge()
    }
  }

  #notify(kind: 'team.leave' | 'team.release', from: string, to: string, op: string): void {
    this.#transport.team(kind, from, to, op).catch((error: unknown) => {
      this.#log(
        `teams: ${kind} to ${to} not delivered (${error instanceof Error ? error.message : String(error)}); reconcile will settle it`,
      )
    })
  }

  // One test for every step that could confirm an edge: asking about it, answering for it, settling it. A member that
  // also leads, or a lead that is also a member, holds a conflicting migrated edge and confirms nothing.
  #eligible(agent: StoredAgent, side: 'lead' | 'member'): boolean {
    return side === 'member' ? !this.#agents.hasMembers(agent.id) : agent.lead === undefined
  }

  #bound(lead: string): boolean {
    return this.#agents.list().some((info) => info.lead === lead)
  }

  #vouch(lead: string, member: string): boolean {
    const roster = this.#rosters.get(lead)
    return (
      roster !== undefined && this.#now() - roster.confirmedAt <= this.#rosterFreshMs && roster.members.has(member) && this.#bound(lead)
    )
  }

  // Only the lead's own gateway issues its roster, and only a gateway with an agent bound to that lead keeps it. Within
  // an epoch a lower revision is a late frame and refused; an equal one is taken too, since a lead restored from a
  // backup can reissue a revision with other members. A new epoch replaces the old one for good.
  #take(roster: TeamRoster, gateway: string): void {
    if (parseRelayPeerId(roster.lead)?.gateway !== gateway || !this.#bound(roster.lead)) {
      return
    }
    const cached = this.#rosters.get(roster.lead)
    const replaced = cached?.replaced ?? new Set<string>()
    if (cached) {
      const fresh = this.#now() - cached.confirmedAt <= this.#rosterFreshMs
      if ((fresh && replaced.has(roster.epoch)) || (cached.epoch === roster.epoch && roster.rev < cached.rev)) {
        return
      }
      if (cached.epoch !== roster.epoch) {
        replaced.add(cached.epoch)
        replaced.delete(roster.epoch)
      }
    }
    const members = new Set(roster.members.map((member) => member.id))
    this.#rosters.set(roster.lead, { epoch: roster.epoch, rev: roster.rev, members, confirmedAt: this.#now(), replaced })
  }

  // A member's gateway holds a later revision than this lead has: the lead's store went back (a restored backup), so
  // it starts a new epoch, which every member's gateway takes as a fresh start. Only a gateway with a member can say so.
  async #seen(seen: TeamSeen, gateway: string): Promise<void> {
    const target = parseRelayPeerId(seen.lead)
    if (target?.gateway !== this.#transport.gateway) {
      return
    }
    let renewed = false
    await this.#agents.patch(target.id, (lead) => {
      const member = (lead.remoteMembers ?? []).some(
        (entry) => entry.state === 'accepted' && parseRelayPeerId(entry.agent)?.gateway === gateway,
      )
      if (!member || !lead.roster || lead.roster.epoch !== seen.epoch || seen.rev <= lead.roster.rev) {
        return lead
      }
      renewed = true
      return { ...lead, roster: { epoch: randomUUID(), rev: 1, digest: this.#agents.rosterDigest(lead.id) } }
    })
    if (renewed) {
      this.#log(`teams: the roster of ${seen.lead} was behind a member's copy; it starts a new epoch`)
    }
  }

  #seenFor(gateway: string): TeamSeen[] {
    return [...this.#rosters]
      .filter(([lead]) => parseRelayPeerId(lead)?.gateway === gateway)
      .map(([lead, roster]) => ({ lead, epoch: roster.epoch, rev: roster.rev }))
  }

  // Rosters of the leads here with accepted members on that gateway, each revision persisted before it is sent.
  async #rostersFor(gateway: string): Promise<TeamRoster[]> {
    const rosters: TeamRoster[] = []
    for (const info of this.#agents.list()) {
      const lead = this.#agents.get(info.id)
      const spans = (lead?.remoteMembers ?? []).some(
        (member) => member.state === 'accepted' && parseRelayPeerId(member.agent)?.gateway === gateway,
      )
      if (!lead || lead.lead !== undefined || !spans || this.#agents.frozen(lead.id)) {
        continue
      }
      let members: TeamRoster['members'] = []
      const outcome = await this.#agents.patch(lead.id, (current) => {
        members = this.#agents.rosterMembers(current.id)
        const digest = this.#agents.rosterDigest(current.id)
        if (current.lead !== undefined || current.roster?.digest === digest) {
          return current
        }
        const roster = current.roster ? { ...current.roster, rev: current.roster.rev + 1, digest } : { epoch: randomUUID(), rev: 1, digest }
        return { ...current, roster }
      })
      if (!isAgentRefusal(outcome) && outcome.roster && outcome.lead === undefined) {
        rosters.push({ lead: `${this.#transport.gateway}:${outcome.id}`, epoch: outcome.roster.epoch, rev: outcome.roster.rev, members })
      }
    }
    return rosters
  }

  #rosterMoved(): void {
    if (this.#stopped || this.#soon) {
      return
    }
    for (const info of this.#agents.list()) {
      const lead = this.#agents.get(info.id)
      const spans = (lead?.remoteMembers ?? []).some((member) => member.state === 'accepted')
      if (lead && spans && lead.lead === undefined && lead.roster?.digest !== this.#agents.rosterDigest(lead.id)) {
        this.#later()
        return
      }
    }
  }

  #later(): void {
    if (this.#soon || this.#stopped) {
      return
    }
    this.#soon = setTimeout(() => {
      this.#soon = undefined
      void this.reconcile()
    }, this.#soonMs)
    this.#soon.unref()
  }

  #edges(): Edge[] {
    const edges: Edge[] = []
    for (const info of this.#agents.list()) {
      const agent = this.#agents.get(info.id)!
      if (this.#agents.frozen(agent.id)) {
        continue
      }
      const leadGateway = this.#agents.remoteGateway(agent.lead)
      if (
        leadGateway &&
        agent.remoteLead?.op !== undefined &&
        (agent.remoteLead.state !== 'unconfirmed' || this.#eligible(agent, 'member'))
      ) {
        edges.push({ gateway: leadGateway, from: agent.id, to: agent.lead!, op: agent.remoteLead.op, side: 'member' })
      }
      for (const member of agent.remoteMembers ?? []) {
        const gateway = member.state === 'invited' ? undefined : parseRelayPeerId(member.agent)?.gateway
        if (gateway && member.op !== undefined && (member.state !== 'unconfirmed' || this.#eligible(agent, 'lead'))) {
          edges.push({ gateway, from: agent.id, to: member.agent, op: member.op, side: 'lead' })
        }
      }
    }
    for (const join of this.#agents.restoredJoins()) {
      const gateway = this.#agents.remoteGateway(join.lead)
      if (gateway) {
        edges.push({ gateway, from: join.id, to: join.lead, op: join.op, side: 'joining' })
      }
    }
    return edges
  }

  async #reconcileOnce(): Promise<void> {
    await this.#pruneInvites()
    for (const lead of this.#rosters.keys()) {
      if (!this.#bound(lead)) {
        this.#rosters.delete(lead)
      }
    }
    const byGateway = new Map<string, Edge[]>()
    for (const edge of this.#edges()) {
      byGateway.set(edge.gateway, [...(byGateway.get(edge.gateway) ?? []), edge])
    }
    const offline = this.#transport.ready() !== undefined
    for (const [gateway, edges] of byGateway) {
      if (this.#stopped) {
        return
      }
      let answer: TeamStatusAnswer | undefined
      if (!offline) {
        try {
          const rosters = await this.#rostersFor(gateway)
          const seen = this.#seenFor(gateway)
          answer = await this.#transport.teamStatus(gateway, {
            edges: edges.map(({ from, to, op }) => ({ from, to, op })),
            ...(rosters.length > 0 ? { rosters } : {}),
            ...(seen.length > 0 ? { seen } : {}),
          })
        } catch {
          answer = undefined
        }
      }
      for (const seen of answer?.seen ?? []) {
        await this.#seen(seen, gateway)
      }
      for (const roster of answer?.rosters ?? []) {
        this.#take(roster, gateway)
      }
      for (const edge of edges) {
        if (this.#stopped) {
          return
        }
        const row = answer?.edges.find((candidate) => candidate.from === edge.from && candidate.to === edge.to && candidate.op === edge.op)
        await this.#settle(edge, row)
      }
    }
  }

  // No answer (offline, timeout, a rule that denies) only marks the edge unreachable; `known: false` from the other
  // gateway itself is the one thing that dissolves it. An unconfirmed half stays unconfirmed until the other side knows it.
  async #settle(edge: Edge, answer: TeamStatusEdge | undefined): Promise<void> {
    if (edge.side === 'joining') {
      await this.#recover(edge, answer)
      return
    }
    const now = this.#now()
    let dissolved: string | undefined
    let released: string | undefined
    const outcome = await this.#agents.patch(edge.from, (agent) => {
      if (edge.side === 'member') {
        const current = agent.remoteLead
        if (agent.lead !== edge.to || current?.op !== edge.op || this.#agents.joiningLead(agent.id) !== undefined) {
          return agent
        }
        if (answer && !answer.known) {
          dissolved = `teams: ${agent.name} left ${current.name}, which no longer lists it`
          const { lead: _lead, remoteLead: _remote, ...rest } = agent
          return rest
        }
        const confirms = current.state !== 'unconfirmed' || this.#eligible(agent, 'member')
        const state = answer && confirms ? 'joined' : current.state === 'unconfirmed' ? 'unconfirmed' : 'unreachable'
        const name = answer?.name ?? current.name
        if (current.state === state && current.name === name) {
          return agent
        }
        return { ...agent, remoteLead: { ...current, name, state, since: current.state === state ? current.since : now } }
      }
      const members = agent.remoteMembers ?? []
      const entry = members.find((member) => member.agent === edge.to && member.op === edge.op && member.state !== 'invited')
      if (!entry) {
        return agent
      }
      if (answer && !answer.known) {
        dissolved = ''
        released = entry.op
        return { ...agent, remoteMembers: members.filter((member) => member !== entry) }
      }
      const next: RemoteMember = { ...entry }
      if (answer) {
        delete next.unreachableSince
        next.name = answer.name ?? entry.name
        next.state = entry.state === 'accepted' || this.#eligible(agent, 'lead') ? 'accepted' : entry.state
      } else if (entry.state === 'accepted') {
        next.unreachableSince = entry.unreachableSince ?? now
      }
      if (next.name === entry.name && next.unreachableSince === entry.unreachableSince && next.state === entry.state) {
        return agent
      }
      return { ...agent, remoteMembers: members.map((member) => (member === entry ? next : member)) }
    })
    if (isAgentRefusal(outcome) || dissolved === undefined) {
      return
    }
    // A member that answered no can still hold the edge, conflicted and unconfirmed; the release clears it there too.
    if (released !== undefined) {
      this.#notify('team.release', edge.from, edge.to, released)
    }
    if (dissolved) {
      this.#log(dissolved)
    }
    this.#transport.nudge()
  }

  // A join read back from the store: the lead's answer for its op commits it, `known: false` drops it, silence keeps it.
  async #recover(edge: Edge, answer: TeamStatusEdge | undefined): Promise<void> {
    if (!answer || this.#agents.joiningOp(edge.from) !== edge.op) {
      return
    }
    if (!answer.known) {
      this.#log(`teams: a join of ${edge.from} to ${edge.to} interrupted by a restart was not accepted; dropped`)
      await this.#agents.releaseJoin(edge.from, edge.op)
      return
    }
    const previous = this.#agents.get(edge.from)
    const joined = this.#joined(edge.to, edge.op, answer.name)
    const outcome = await this.#agents.update(edge.from, { lead: edge.to }, { joined })
    await this.#agents.releaseJoin(edge.from, edge.op)
    if (isAgentRefusal(outcome)) {
      this.#notify('team.leave', edge.from, edge.to, edge.op)
      return
    }
    this.#log(`teams: ${outcome.name} finished joining ${joined.remoteLead.name} after a restart`)
    this.#movedOff(edge.from, previous, edge.to)
  }

  async #pruneInvites(): Promise<void> {
    for (const info of this.#agents.list()) {
      if (this.#agents.frozen(info.id)) {
        continue
      }
      await this.#agents.patch(info.id, (agent) => {
        const now = this.#now()
        const members = agent.remoteMembers ?? []
        const kept = members.filter((member) => member.state !== 'invited' || (member.expiresAt ?? Infinity) > now)
        return kept.length === members.length ? agent : { ...agent, remoteMembers: kept }
      })
    }
  }
}
