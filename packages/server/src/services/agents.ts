import { createHash, randomUUID } from 'node:crypto'
import {
  AGENT_SLEEP_AFTER_MS_DEFAULT,
  agentRef,
  isSharing,
  type AgentConfig,
  type AgentInfo,
  type SessionInfo,
  type Sharing,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import { parseRelayPeerId, type RelayAgentEntry } from '@workerdeck/relay-client'
import { AGENT_SCHEMA, type AgentStore, type StoredAgent } from './agent-store.ts'

export type AgentServiceOptions = {
  store: AgentStore
  basePath: string
  avatars?: boolean
  sleepAfterMs?: number
  // The permission mode the agent's session runs in, or would start in: its config, its live session, its profile.
  modeOf?: (agent: StoredAgent) => string | undefined
  // False when the gateway shares no agent with other owners: stored sharing stays, but nothing is shared.
  allowShared?: boolean
  // This gateway's relay name: a lead id qualified with it is local.
  gateway?: string
  now?: () => number
}

export type AgentRefusal = { status: number; error: string }

export const SHARING_OFF = 'this gateway shares no agents with other owners'

export type RetireOutcome = { retired: StoredAgent[]; released: StoredAgent[] }

export type RemoteJoin = Required<Pick<StoredAgent, 'lead' | 'remoteLead'>>

export type AgentMutation = (current: StoredAgent) => StoredAgent | AgentRefusal

export type UpdateOptions = {
  joined?: RemoteJoin
  // The patch's `owner` was checked by the caller against the owners this gateway knows.
  onLeadChanged?: (previous: StoredAgent) => void
  // `lead: null` also cancels a join in progress; its lead's acceptance, if any, is then withdrawn with a leave.
  onJoinCancelled?: (lead: string, op: string) => void
}

// `restored`: read back from the store at hydrate, so no request in this process is waiting on it.
type JoinReservation = { lead: string; name: string; op: string; restored?: boolean }

export type RosterMember = { id: string; name: string }

// Whether a cached, fresh roster of a lead on another gateway lists this member (`TeamLinks` holds the rosters).
export type RosterCheck = (lead: string, member: string) => boolean

const NAMES = [
  'Atlas',
  'Juno',
  'Pip',
  'Rook',
  'Marlow',
  'Orbit',
  'Fern',
  'Quill',
  'Sable',
  'Wren',
  'Ember',
  'Moss',
  'Nova',
  'Otto',
  'Pike',
  'Rune',
  'Sage',
  'Tansy',
  'Vale',
  'Yarrow',
  'Basil',
  'Cedar',
  'Dune',
  'Flint',
  'Hazel',
  'Iris',
  'Kestrel',
  'Lark',
  'Maple',
  'Nettle',
  'Onyx',
  'Piper',
  'Reed',
  'Sorrel',
  'Thistle',
  'Umber',
  'Willow',
  'Zephyr',
]
const MAX_NAME = 64
const MAX_BRIEF = 16_000
const CONFIG_KEYS: readonly (keyof AgentConfig)[] = [
  'cwd',
  'profile',
  'model',
  'reasoningEffort',
  'permissionMode',
  'brief',
  'agentContextReset',
  'sleepAfterMs',
]

export class AgentService {
  #store: AgentStore
  #basePath: string
  #avatars: boolean
  #sleepAfterMs: number
  #allowShared: boolean
  #modeOf: (agent: StoredAgent) => string | undefined
  #gateway: string | undefined
  #now: () => number
  #agents = new Map<string, StoredAgent>()
  #joining = new Map<string, JoinReservation>()
  #retired = new Set<string>()
  #frozen = new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false
  #hydrated = false
  #rosterCheck: RosterCheck = () => false
  #listeners = new Set<() => void>()

  constructor(options: AgentServiceOptions) {
    this.#store = options.store
    this.#basePath = options.basePath
    this.#avatars = options.avatars ?? false
    this.#sleepAfterMs = options.sleepAfterMs ?? AGENT_SLEEP_AFTER_MS_DEFAULT
    this.#allowShared = options.allowShared !== false
    this.#modeOf = options.modeOf ?? ((agent) => agent.config.permissionMode)
    this.#gateway = options.gateway
    this.#now = options.now ?? Date.now
  }

  // Every hydrate normalizes the records to the current schema (idempotent, so an interrupted pass reruns to the same
  // result) and writes what changed as one store change. A record from a newer schema is loaded but never written.
  async hydrate(): Promise<void> {
    const stored = await this.#store.list()
    const changed: StoredAgent[] = []
    this.#frozen = new Set()
    this.#joining = new Map()
    const agents = new Map<string, StoredAgent>()
    for (const agent of stored) {
      if ((agent.schema ?? 0) > AGENT_SCHEMA) {
        this.#frozen.add(agent.id)
        agents.set(agent.id, agent)
        continue
      }
      const next = this.#gateway === undefined ? agent : normalizeAgent(agent, this.#gateway, this.#now())
      if (next !== agent) {
        changed.push(next)
      }
      agents.set(next.id, next)
      if (next.pendingJoin && this.#gateway !== undefined) {
        this.#joining.set(next.id, { lead: next.pendingJoin.lead, name: next.name, op: next.pendingJoin.op, restored: true })
      }
    }
    if (changed.length > 0) {
      await this.#apply(changed, [])
    }
    this.#agents = agents
    this.#hydrated = true
  }

  // Until the store is read, this gateway knows no agent, and must not answer another gateway as if it knew them all.
  hydrated(): boolean {
    return this.#hydrated
  }

  useRosters(check: RosterCheck): void {
    this.#rosterCheck = check
  }

  // Called after every committed write; `TeamLinks` uses it to send a changed roster without waiting for its timer.
  onWrite(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  frozen(id: string): boolean {
    return this.#frozen.has(id)
  }

  close(): Promise<void> {
    this.#closed = true
    return this.#queue.then(() => {})
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()].map((agent) => this.public(agent))
  }

  get(id: string): StoredAgent | undefined {
    return this.#agents.get(id)
  }

  bySession(sessionId: string): StoredAgent | undefined {
    for (const agent of this.#agents.values()) {
      if (agent.sessionId === sessionId) {
        return agent
      }
    }
    return undefined
  }

  decorate(info: SessionInfo): SessionInfo {
    const agent = this.bySession(info.id)
    if (!agent) {
      return info
    }
    const remote = this.remoteGateway(agent.lead)
    const leadName = agent.lead === undefined ? undefined : remote ? agent.remoteLead?.name : this.#agents.get(agent.lead)?.name
    const owner = agent.owner ?? info.owner
    const ref = agentRef(this.public(agent), { leadName, leadGateway: remote, leads: this.hasMembers(agent.id) })
    if (!this.#allowShared) {
      delete ref.shared
    }
    return { ...info, ...(owner === undefined ? {} : { owner }), agent: ref }
  }

  // The gateway a lead id names when it is not this one; undefined for a local or absent lead.
  remoteGateway(lead: string | undefined): string | undefined {
    const target = lead === undefined ? undefined : parseRelayPeerId(lead)
    return target && target.gateway !== this.#gateway ? target.gateway : undefined
  }

  localId(id: string): string {
    const target = parseRelayPeerId(id)
    return target && target.gateway === this.#gateway ? target.id : id
  }

  // A member is published to the relay only when its team spans gateways; the relay's team rule then decides who sees it.
  spansGateways(agent: StoredAgent): boolean {
    if (agent.lead === undefined) {
      return false
    }
    if (this.remoteGateway(agent.lead)) {
      return true
    }
    return acceptedRemote(this.#agents.get(agent.lead)).length > 0
  }

  relayAgent(sessionId: string): RelayAgentEntry | undefined {
    const agent = this.bySession(sessionId)
    if (!agent || this.#frozen.has(agent.id)) {
      return undefined
    }
    const entry: RelayAgentEntry = { id: agent.id, name: agent.name }
    if (agent.lead !== undefined) {
      entry.lead = agent.lead
    }
    if (agent.order !== undefined) {
      entry.order = agent.order
    }
    const accepts = acceptedRemote(agent).map((member) => member.agent)
    if (accepts.length > 0) {
      entry.accepts = accepts
    }
    if (agent.sharing === 'shared' && agent.lead === undefined && this.#allowShared) {
      entry.shared = true
    }
    return entry
  }

  // Whether this gateway's records allow a remote agent's claims: its id names the gateway it came from, a claim to be a
  // member of a lead here needs that lead's accepted entry, and a claim to a lead on a third gateway needs that lead's
  // fresh roster, held here because an agent of this gateway is bound to the same lead.
  vouches(ref: { id: string; lead?: string }, gateway: string, owner?: string): boolean {
    if (gateway === this.#gateway || parseRelayPeerId(ref.id)?.gateway !== gateway) {
      return false
    }
    if (ref.lead === undefined) {
      return true
    }
    const lead = parseRelayPeerId(ref.lead)
    if (!lead) {
      return false
    }
    if (lead.gateway !== this.#gateway) {
      return this.#rosterCheck(ref.lead, ref.id)
    }
    const record = this.#agents.get(lead.id)
    return (
      record?.lead === undefined &&
      acceptedRemote(record).some(
        (member) => member.agent === ref.id && (member.owner === undefined || owner === undefined || member.owner === owner),
      )
    )
  }

  briefFor(sessionId: string | undefined): string | undefined {
    const brief = sessionId === undefined ? undefined : this.bySession(sessionId)?.config.brief?.trim()
    return brief || undefined
  }

  sleepAfterFor(sessionId: string): number | undefined {
    const agent = this.bySession(sessionId)
    return agent ? (agent.config.sleepAfterMs ?? this.#sleepAfterMs) : undefined
  }

  // The lead's members as its roster lists them: local members and accepted remote ones, qualified, ordered by id.
  rosterMembers(leadId: string): RosterMember[] {
    const lead = this.#agents.get(leadId)
    if (!lead || lead.lead !== undefined || this.#gateway === undefined) {
      return []
    }
    const local = this.members(leadId).map((member) => ({ id: `${this.#gateway}:${member.id}`, name: member.name }))
    const remote = acceptedRemote(lead).map((member) => ({ id: member.agent, name: member.name ?? member.agent }))
    return [...local, ...remote].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  rosterDigest(leadId: string): string {
    return createHash('sha1')
      .update(JSON.stringify(this.rosterMembers(leadId)))
      .digest('hex')
  }

  public(agent: StoredAgent): AgentInfo {
    const {
      avatarSeed: _seed,
      avatarRecipe: _recipe,
      avatar: _avatar,
      schema: _schema,
      pendingJoin: _pending,
      roster: _roster,
      ...info
    } = agent
    if (!this.#avatars) {
      return info
    }
    // Versioned by the seed, so a changed avatar is a new address to every client cache keyed by it.
    const version = agent.avatarSeed === agent.id ? '' : `?v=${createHash('sha1').update(agent.avatarSeed).digest('hex').slice(0, 10)}`
    return { ...info, avatar: `${this.#basePath}/agents/${agent.id}/avatar.png${version}` }
  }

  draft(input: {
    name?: unknown
    config?: unknown
    lead?: unknown
    owner?: string
    sharing?: Sharing
    crossOwner?: boolean
  }): StoredAgent | AgentRefusal {
    const config = readConfig(input.config)
    if ('error' in config) {
      return config
    }
    const name = input.name === undefined ? this.#suggestName() : readName(input.name)
    if (typeof name !== 'string') {
      return name
    }
    const id = randomUUID()
    const at = this.#now()
    const agent: StoredAgent = {
      id,
      schema: AGENT_SCHEMA,
      name,
      createdAt: at,
      updatedAt: at,
      avatarSeed: id,
      pastSessions: [],
      config,
      ...(input.owner === undefined ? {} : { owner: input.owner }),
      ...(input.sharing === undefined ? {} : { sharing: input.sharing }),
    }
    if (input.lead !== undefined && input.lead !== null) {
      if (typeof input.lead !== 'string') {
        return { status: 400, error: 'lead must be an agent id' }
      }
      const leadId = this.localId(input.lead)
      const refused = this.leadRefusal(agent, leadId, input.crossOwner === true)
      if (refused) {
        return refused
      }
      // A lead on another gateway is set by the caller once the relay has answered the join.
      if (!this.remoteGateway(leadId)) {
        agent.lead = leadId
      }
    }
    return agent
  }

  create(agent: StoredAgent, joined?: RemoteJoin, crossOwner = false): Promise<StoredAgent | AgentRefusal> {
    return this.#transition(async () => {
      if (this.#agents.has(agent.id) || this.#retired.has(agent.id)) {
        return { status: 409, error: `agent ${agent.id} already exists` }
      }
      if (agent.sessionId !== undefined && this.bySession(agent.sessionId)) {
        return { status: 409, error: 'that session already belongs to an agent' }
      }
      const next: StoredAgent = { ...agent }
      if (joined) {
        if (!this.#holdsJoin(agent.id, joined)) {
          return { status: 409, error: `${agent.name} is no longer joining that team` }
        }
        next.lead = joined.lead
        next.remoteLead = joined.remoteLead
        delete next.pendingJoin
      } else if (next.lead !== undefined) {
        const refused = this.leadRefusal(next, next.lead, crossOwner)
        if (refused) {
          return refused
        }
      }
      return this.#write(next)
    })
  }

  patch(id: string, mutate: AgentMutation): Promise<StoredAgent | AgentRefusal> {
    return this.#transition(async () => {
      const current = this.#agents.get(id)
      if (!current) {
        return { status: 404, error: `no such agent: ${id}` }
      }
      if (this.#frozen.has(id)) {
        return { status: 409, error: `${current.name} was written by a newer WorkerDeck; this one leaves it as it is` }
      }
      const next = mutate(current)
      if (isAgentRefusal(next) || next === current) {
        return next
      }
      return this.#write(next)
    })
  }

  bind(id: string, sessionId: string, avatarRecipe?: unknown): Promise<StoredAgent | AgentRefusal> {
    return this.patch(id, (agent) => {
      const owner = this.bySession(sessionId)
      if (owner && owner.id !== id) {
        return { status: 409, error: 'that session already belongs to an agent' }
      }
      const past =
        agent.sessionId !== undefined && agent.sessionId !== sessionId ? [...agent.pastSessions, agent.sessionId] : agent.pastSessions
      const next: StoredAgent = { ...agent, sessionId, pastSessions: past }
      if (next.avatarRecipe === undefined && avatarRecipe !== undefined) {
        next.avatarRecipe = avatarRecipe
      }
      return next
    })
  }

  hasMembers(id: string): boolean {
    if (acceptedRemote(this.#agents.get(id)).length > 0) {
      return true
    }
    for (const agent of this.#agents.values()) {
      if (agent.lead === id) {
        return true
      }
    }
    return false
  }

  members(id: string): StoredAgent[] {
    return [...this.#agents.values()].filter((agent) => agent.lead === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  }

  // Teams are one level deep: a lead cannot join a team and a member cannot lead one. A local lead of another owner
  // needs `crossOwner`, the caller's confirmation; a remote one is the lead's gateway's to accept or refuse.
  leadRefusal(mover: StoredAgent, leadId: string, crossOwner = false): AgentRefusal | null {
    if (leadId === mover.id) {
      return { status: 409, error: 'an agent cannot lead its own team' }
    }
    if ((mover.remoteMembers ?? []).some((member) => member.state === 'unconfirmed')) {
      return { status: 409, error: `${mover.name} has team members waiting to be confirmed` }
    }
    if (this.remoteGateway(leadId)) {
      if (this.hasMembers(mover.id)) {
        return { status: 409, error: `${mover.name} leads a team; teams are one level deep` }
      }
      if (this.pendingInvites(mover).length > 0) {
        return { status: 409, error: `${mover.name} has open team invitations; withdraw them first` }
      }
      return null
    }
    const lead = this.#agents.get(leadId)
    if (!lead) {
      return { status: 404, error: `no such agent: ${leadId}` }
    }
    if (lead.lead !== undefined) {
      return { status: 409, error: `${lead.name} is a member of a team; teams are one level deep` }
    }
    if (this.#joining.has(lead.id)) {
      return { status: 409, error: `${lead.name} is joining a team` }
    }
    if (this.hasMembers(mover.id)) {
      return { status: 409, error: `${mover.name} leads a team; teams are one level deep` }
    }
    if (!crossOwner && lead.owner !== mover.owner) {
      return {
        status: 409,
        error: `${mover.name} belongs to ${mover.owner ?? 'no owner'} and ${lead.name} to ${lead.owner ?? 'no owner'}; confirm a team across owners`,
      }
    }
    if (lead.owner !== mover.owner) {
      return this.unpromptedRefusal(mover) ?? this.unpromptedRefusal(lead)
    }
    return null
  }

  // A team across owners never holds an agent that runs tools without asking (decision 15).
  unpromptedRefusal(agent: StoredAgent): AgentRefusal | null {
    const mode = this.#modeOf(agent)
    return mode === 'bypassPermissions' || mode === 'dontAsk'
      ? { status: 409, error: `${agent.name} runs without permission prompts (${mode}); a team across owners needs them` }
      : null
  }

  // For records from before owners: each agent without one gets its profile's owner once that resolves, and keeps it.
  stampOwners(ownerFor: (agent: StoredAgent) => string | undefined): Promise<number> {
    return this.#transition(async () => {
      const at = this.#now()
      const stamped = [...this.#agents.values()].flatMap((agent) => {
        const owner = agent.owner === undefined && !this.#frozen.has(agent.id) ? ownerFor(agent) : undefined
        return owner === undefined ? [] : [{ ...agent, owner, schema: AGENT_SCHEMA, updatedAt: at }]
      })
      if (stamped.length === 0) {
        return 0
      }
      await this.#apply(stamped, [])
      for (const agent of stamped) {
        this.#agents.set(agent.id, agent)
      }
      this.#changed()
      return stamped.length
    })
  }

  // Why an agent's owner cannot move now: every edge it holds was agreed under the owner it has.
  transferRefusal(agent: StoredAgent): AgentRefusal | null {
    const edges =
      agent.lead !== undefined ||
      this.hasMembers(agent.id) ||
      (agent.remoteMembers ?? []).length > 0 ||
      agent.pendingJoin !== undefined ||
      this.#joining.has(agent.id)
    return edges ? { status: 409, error: `${agent.name} is in a team or joining one; its owner moves only outside teams` } : null
  }

  joiningLead(id: string): string | undefined {
    return this.#joining.get(id)?.lead
  }

  joiningName(id: string): string | undefined {
    return this.#joining.get(id)?.name
  }

  joiningOp(id: string): string | undefined {
    return this.#joining.get(id)?.op
  }

  // Joins read back from the store at hydrate: `TeamLinks` asks their leads whether they accepted and commits or drops.
  restoredJoins(): Array<{ id: string; lead: string; op: string }> {
    return [...this.#joining].flatMap(([id, join]) => (join.restored ? [{ id, lead: join.lead, op: join.op }] : []))
  }

  // One slot per agent, written to the store with the agent's record (a draft has none, and a crashed create has no
  // agent to commit), so a restart cannot open a second join while the lead may have accepted the first.
  reserveJoin(mover: StoredAgent, lead: string): Promise<{ op: string } | AgentRefusal> {
    return this.#transition(async () => {
      if (this.#retired.has(mover.id)) {
        return { status: 404, error: `no such agent: ${mover.id}` }
      }
      if (this.#frozen.has(mover.id)) {
        return { status: 409, error: `${mover.name} was written by a newer WorkerDeck; this one leaves it as it is` }
      }
      if (this.#joining.has(mover.id)) {
        return { status: 409, error: `${mover.name} is already joining a team` }
      }
      const stored = this.#agents.get(mover.id)
      const current = stored ?? mover
      const refused = this.leadRefusal(current, lead)
      if (refused) {
        return refused
      }
      const op = randomUUID()
      if (stored) {
        await this.#write({ ...stored, pendingJoin: { op, lead, at: this.#now() } })
      }
      this.#joining.set(mover.id, { lead, name: current.name, op })
      return { op }
    })
  }

  releaseJoin(id: string, op: string): Promise<void> {
    if (this.#joining.get(id)?.op !== op) {
      return Promise.resolve()
    }
    this.#joining.delete(id)
    return this.#transition(async () => {
      const current = this.#agents.get(id)
      if (current?.pendingJoin?.op === op && !this.#frozen.has(id)) {
        const { pendingJoin: _pending, ...rest } = current
        await this.#write(rest)
      }
    }).catch(() => {})
  }

  pendingInvites(agent: StoredAgent): NonNullable<StoredAgent['remoteMembers']> {
    const now = this.#now()
    return (agent.remoteMembers ?? []).filter((member) => member.state === 'invited' && (member.expiresAt ?? Infinity) > now)
  }

  // A lead on another gateway is only ever written with the relay's answer in hand (`joined`), never from a bare patch.
  update(id: string, patch: UpdateAgentRequest, options: UpdateOptions = {}): Promise<StoredAgent | AgentRefusal> {
    const { joined } = options
    let previous: StoredAgent | undefined
    let cancelled: JoinReservation | undefined
    const updated = this.patch(id, (agent) => {
      previous = agent
      cancelled = undefined
      const next: StoredAgent = { ...agent }
      if (patch.name !== undefined) {
        const name = readName(patch.name)
        if (typeof name !== 'string') {
          return name
        }
        next.name = name
      }
      if (patch.owner !== undefined && patch.owner !== agent.owner) {
        const refused = this.transferRefusal(agent)
        if (refused) {
          return refused
        }
        next.owner = patch.owner
      }
      if (patch.sharing !== undefined) {
        if (!isSharing(patch.sharing)) {
          return { status: 400, error: "sharing must be 'private' or 'shared'" }
        }
        if (patch.sharing === 'shared' && !this.#allowShared) {
          return { status: 409, error: SHARING_OFF }
        }
        next.sharing = patch.sharing
      }
      if (patch.config !== undefined) {
        if (!isRecord(patch.config)) {
          return { status: 400, error: 'config must be an object' }
        }
        const config = readConfig({ ...agent.config, ...patch.config })
        if ('error' in config) {
          return config
        }
        next.config = config
      }
      if (patch.lead !== undefined && patch.lead !== null && this.#joining.has(id) && joined === undefined) {
        return { status: 409, error: `${agent.name} is joining a team` }
      }
      if (patch.lead === null) {
        cancelled = this.#joining.get(id)
        delete next.pendingJoin
        delete next.lead
        delete next.remoteLead
      } else if (patch.lead !== undefined) {
        if (typeof patch.lead !== 'string') {
          return { status: 400, error: 'lead must be an agent id or null' }
        }
        const leadId = this.localId(patch.lead)
        if (this.remoteGateway(leadId)) {
          if (joined?.lead !== leadId || !this.#holdsJoin(id, joined)) {
            return { status: 409, error: 'a lead on another gateway is joined through the relay' }
          }
          if (this.hasMembers(id)) {
            return { status: 409, error: `${agent.name} leads a team; teams are one level deep` }
          }
          next.lead = joined.lead
          next.remoteLead = joined.remoteLead
          delete next.pendingJoin
        } else {
          const refused = this.leadRefusal(next, leadId, patch.crossOwner === true)
          if (refused) {
            return refused
          }
          next.lead = leadId
          delete next.remoteLead
        }
      }
      if (patch.order !== undefined) {
        if (typeof patch.order !== 'number' || !Number.isFinite(patch.order)) {
          return { status: 400, error: 'order must be a number' }
        }
        next.order = patch.order
      }
      if (cancelled) {
        this.#joining.delete(id)
      }
      return next
    })
    return updated.then((result) => {
      if (!isAgentRefusal(result) && previous && result.lead !== previous.lead) {
        options.onLeadChanged?.(previous)
      }
      if (!isAgentRefusal(result) && cancelled) {
        options.onJoinCancelled?.(cancelled.lead, cancelled.op)
      }
      return result
    })
  }

  retire(id: string, members: 'release' | 'retire'): Promise<RetireOutcome | AgentRefusal> {
    return this.#transition(async () => {
      const agent = this.#agents.get(id)
      if (!agent) {
        return { status: 404, error: `no such agent: ${id}` }
      }
      if (this.#frozen.has(id)) {
        return { status: 409, error: `${agent.name} was written by a newer WorkerDeck; this one leaves it as it is` }
      }
      const crew = this.members(id).filter((member) => !this.#frozen.has(member.id))
      const retired = [agent, ...(members === 'retire' ? crew : [])]
      const at = this.#now()
      const released =
        members === 'release' ? crew.map(({ lead: _lead, remoteLead: _remote, ...rest }) => ({ ...rest, updatedAt: at })) : []
      await this.#apply(
        released,
        retired.map((gone) => gone.id),
      )
      for (const gone of retired) {
        this.#agents.delete(gone.id)
        this.#joining.delete(gone.id)
        this.#retired.add(gone.id)
      }
      for (const member of released) {
        this.#agents.set(member.id, member)
      }
      this.#changed()
      return { retired, released }
    })
  }

  #holdsJoin(id: string, joined: RemoteJoin): boolean {
    const join = this.#joining.get(id)
    return join !== undefined && join.lead === joined.lead && join.op === joined.remoteLead.op
  }

  #changed(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }

  #transition<T>(step: () => T | Promise<T>): Promise<T> {
    const run = this.#queue.then(() => {
      if (this.#closed) {
        throw new Error('this gateway generation has ended; its agent store is closed')
      }
      return step()
    })
    this.#queue = run.catch(() => {})
    return run
  }

  async #write(agent: StoredAgent): Promise<StoredAgent> {
    const stored: StoredAgent = { ...agent, schema: AGENT_SCHEMA, updatedAt: this.#now() }
    await this.#apply([stored], [])
    this.#agents.set(stored.id, stored)
    this.#changed()
    return stored
  }

  async #apply(saves: StoredAgent[], deletes: string[]): Promise<void> {
    if (this.#store.apply) {
      await this.#store.apply({ saves, deletes })
      return
    }
    // Deletes first: a store that fails partway then leaves a member pointing at a missing lead, which stays
    // restricted, never a released member whose lead still exists.
    for (const id of deletes) {
      await this.#store.delete(id)
    }
    for (const agent of saves) {
      await this.#store.save(agent)
    }
  }

  #suggestName(): string {
    const taken = new Set([...this.#agents.values()].map((agent) => agent.name.toLowerCase()))
    const free = NAMES.find((name) => !taken.has(name.toLowerCase()))
    if (free) {
      return free
    }
    for (let n = 2; ; n++) {
      const name = `${NAMES[n % NAMES.length]} ${n}`
      if (!taken.has(name.toLowerCase())) {
        return name
      }
    }
  }
}

// The op both gateways derive for an edge stored before operation ids, without talking to each other.
export function legacyOp(lead: string, member: string): string {
  return `v1:${createHash('sha1').update(`${lead}>${member}`).digest('hex').slice(0, 32)}`
}

// Schema 2. Halves stored before operation ids get the derived op and wait, restricted and unpublished, until the other
// gateway confirms them; a `remoteLead` an older binary left behind a local or cleared lead is dropped.
export function normalizeAgent(agent: StoredAgent, gateway: string, now: number): StoredAgent {
  const next: StoredAgent = { ...agent, schema: AGENT_SCHEMA }
  const self = `${gateway}:${agent.id}`
  const leadGateway = agent.lead === undefined ? undefined : parseRelayPeerId(agent.lead)?.gateway
  if (leadGateway === undefined || leadGateway === gateway) {
    delete next.remoteLead
  } else if (agent.remoteLead?.op === undefined) {
    next.remoteLead = {
      name: agent.remoteLead?.name ?? agent.lead!,
      ...(agent.remoteLead?.owner === undefined ? {} : { owner: agent.remoteLead.owner }),
      state: 'unconfirmed',
      since: agent.remoteLead?.since ?? now,
      op: legacyOp(agent.lead!, self),
    }
  }
  if (agent.remoteMembers?.some((member) => member.state === 'accepted' && member.op === undefined)) {
    next.remoteMembers = agent.remoteMembers.map((member) =>
      member.state === 'accepted' && member.op === undefined
        ? { ...member, state: 'unconfirmed', op: legacyOp(self, member.agent) }
        : member,
    )
  }
  if (agent.sharing !== undefined && !isSharing(agent.sharing)) {
    delete next.sharing
  }
  const pendingRemote = agent.pendingJoin && parseRelayPeerId(agent.pendingJoin.lead)?.gateway
  if (agent.pendingJoin && (pendingRemote === undefined || pendingRemote === gateway)) {
    delete next.pendingJoin
  }
  return JSON.stringify(next) === JSON.stringify(agent) ? agent : next
}

function acceptedRemote(agent: StoredAgent | undefined): NonNullable<StoredAgent['remoteMembers']> {
  return (agent?.remoteMembers ?? []).filter((member) => member.state === 'accepted')
}

export function isAgentRefusal(value: unknown): value is AgentRefusal {
  return isRecord(value) && typeof value.status === 'number' && typeof value.error === 'string'
}

function readName(value: unknown): string | AgentRefusal {
  if (typeof value !== 'string' || value.trim() === '') {
    return { status: 400, error: 'name must be a non-empty string' }
  }
  const name = value.trim()
  return name.length > MAX_NAME ? { status: 400, error: `name is longer than ${MAX_NAME} characters` } : name
}

function readConfig(value: unknown): AgentConfig | AgentRefusal {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    return { status: 400, error: 'config must be an object' }
  }
  const config: Record<string, unknown> = {}
  for (const key of CONFIG_KEYS) {
    if (value[key] !== undefined) {
      config[key] = value[key]
    }
  }
  for (const key of ['cwd', 'profile', 'model', 'reasoningEffort', 'permissionMode', 'brief'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      return { status: 400, error: `config.${key} must be a string` }
    }
  }
  if (config.agentContextReset !== undefined && typeof config.agentContextReset !== 'boolean') {
    return { status: 400, error: 'config.agentContextReset must be a boolean' }
  }
  const sleep = config.sleepAfterMs
  if (sleep !== undefined && (typeof sleep !== 'number' || !Number.isFinite(sleep) || sleep < 0)) {
    return { status: 400, error: 'config.sleepAfterMs must be a non-negative number' }
  }
  if (typeof config.brief === 'string' && config.brief.length > MAX_BRIEF) {
    return { status: 400, error: `config.brief is longer than ${MAX_BRIEF} characters` }
  }
  return config as AgentConfig
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
