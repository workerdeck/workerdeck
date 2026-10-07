import { createHash, randomUUID } from 'node:crypto'
import {
  AGENT_SLEEP_AFTER_MS_DEFAULT,
  agentRef,
  type AgentConfig,
  type AgentInfo,
  type SessionInfo,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import { parseRelayPeerId, type RelayAgentEntry } from '@workerdeck/relay-client'
import type { AgentStore, StoredAgent } from './agent-store.ts'

export type AgentServiceOptions = {
  store: AgentStore
  basePath: string
  avatars?: boolean
  sleepAfterMs?: number
  // This gateway's relay name: a lead id qualified with it is local.
  gateway?: string
  now?: () => number
}

export type AgentRefusal = { status: number; error: string }

export type RetireOutcome = { retired: StoredAgent[]; released: StoredAgent[] }

export type RemoteJoin = Required<Pick<StoredAgent, 'lead' | 'remoteLead'>>

export type AgentMutation = (current: StoredAgent) => StoredAgent | AgentRefusal

export type UpdateOptions = { joined?: RemoteJoin; onLeadChanged?: (previous: string | undefined) => void }

type JoinReservation = { lead: string; name: string }

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
  #gateway: string | undefined
  #now: () => number
  #agents = new Map<string, StoredAgent>()
  #joining = new Map<string, JoinReservation>()
  #retired = new Set<string>()
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(options: AgentServiceOptions) {
    this.#store = options.store
    this.#basePath = options.basePath
    this.#avatars = options.avatars ?? false
    this.#sleepAfterMs = options.sleepAfterMs ?? AGENT_SLEEP_AFTER_MS_DEFAULT
    this.#gateway = options.gateway
    this.#now = options.now ?? Date.now
  }

  async hydrate(): Promise<void> {
    this.#agents = new Map((await this.#store.list()).map((agent) => [agent.id, agent]))
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
    return { ...info, agent: agentRef(this.public(agent), { leadName, leadGateway: remote, leads: this.hasMembers(agent.id) }) }
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
    if (!agent) {
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
    return entry
  }

  // Whether this gateway's records allow a remote agent's claims: its id names the gateway it came from, and a claim to
  // be a member of a lead here needs that lead's accepted entry. A claim to a lead on another gateway is that relay's
  // assertion until the lead's roster exists (R3 workstream E).
  vouches(ref: { id: string; lead?: string }, gateway: string): boolean {
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
      return true
    }
    const record = this.#agents.get(lead.id)
    return record?.lead === undefined && acceptedRemote(record).some((member) => member.agent === ref.id)
  }

  briefFor(sessionId: string | undefined): string | undefined {
    const brief = sessionId === undefined ? undefined : this.bySession(sessionId)?.config.brief?.trim()
    return brief || undefined
  }

  sleepAfterFor(sessionId: string): number | undefined {
    const agent = this.bySession(sessionId)
    return agent ? (agent.config.sleepAfterMs ?? this.#sleepAfterMs) : undefined
  }

  public(agent: StoredAgent): AgentInfo {
    const { avatarSeed: _seed, avatarRecipe: _recipe, avatar: _avatar, ...info } = agent
    if (!this.#avatars) {
      return info
    }
    // Versioned by the seed, so a changed avatar is a new address to every client cache keyed by it.
    const version = agent.avatarSeed === agent.id ? '' : `?v=${createHash('sha1').update(agent.avatarSeed).digest('hex').slice(0, 10)}`
    return { ...info, avatar: `${this.#basePath}/agents/${agent.id}/avatar.png${version}` }
  }

  draft(input: { name?: unknown; config?: unknown; lead?: unknown }): StoredAgent | AgentRefusal {
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
      name,
      createdAt: at,
      updatedAt: at,
      avatarSeed: id,
      pastSessions: [],
      config,
    }
    if (input.lead !== undefined && input.lead !== null) {
      if (typeof input.lead !== 'string') {
        return { status: 400, error: 'lead must be an agent id' }
      }
      const leadId = this.localId(input.lead)
      const refused = this.leadRefusal(agent, leadId)
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

  create(agent: StoredAgent, joined?: RemoteJoin): Promise<StoredAgent | AgentRefusal> {
    return this.#transition(async () => {
      if (this.#agents.has(agent.id) || this.#retired.has(agent.id)) {
        return { status: 409, error: `agent ${agent.id} already exists` }
      }
      if (agent.sessionId !== undefined && this.bySession(agent.sessionId)) {
        return { status: 409, error: 'that session already belongs to an agent' }
      }
      const next: StoredAgent = { ...agent }
      if (joined) {
        if (this.#joining.get(agent.id)?.lead !== joined.lead) {
          return { status: 409, error: `${agent.name} is no longer joining that team` }
        }
        next.lead = joined.lead
        next.remoteLead = joined.remoteLead
      } else if (next.lead !== undefined) {
        const refused = this.leadRefusal(next, next.lead)
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

  // Teams are one level deep: a lead cannot join a team and a member cannot lead one.
  leadRefusal(mover: StoredAgent, leadId: string): AgentRefusal | null {
    if (leadId === mover.id) {
      return { status: 409, error: 'an agent cannot lead its own team' }
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
    return null
  }

  joiningLead(id: string): string | undefined {
    return this.#joining.get(id)?.lead
  }

  joiningName(id: string): string | undefined {
    return this.#joining.get(id)?.name
  }

  reserveJoin(mover: StoredAgent, lead: string): Promise<AgentRefusal | null> {
    return this.#transition(() => {
      if (this.#retired.has(mover.id)) {
        return { status: 404, error: `no such agent: ${mover.id}` }
      }
      if (this.#joining.has(mover.id)) {
        return { status: 409, error: `${mover.name} is already joining a team` }
      }
      const current = this.#agents.get(mover.id) ?? mover
      const refused = this.leadRefusal(current, lead)
      if (refused) {
        return refused
      }
      this.#joining.set(mover.id, { lead, name: current.name })
      return null
    })
  }

  releaseJoin(id: string, lead: string): void {
    if (this.#joining.get(id)?.lead === lead) {
      this.#joining.delete(id)
    }
  }

  pendingInvites(agent: StoredAgent): NonNullable<StoredAgent['remoteMembers']> {
    const now = this.#now()
    return (agent.remoteMembers ?? []).filter((member) => member.state === 'invited' && (member.expiresAt ?? Infinity) > now)
  }

  // A lead on another gateway is only ever written with the relay's answer in hand (`joined`), never from a bare patch.
  update(id: string, patch: UpdateAgentRequest, options: UpdateOptions = {}): Promise<StoredAgent | AgentRefusal> {
    const { joined } = options
    let previous: string | undefined
    const updated = this.patch(id, (agent) => {
      previous = agent.lead
      const next: StoredAgent = { ...agent }
      if (patch.name !== undefined) {
        const name = readName(patch.name)
        if (typeof name !== 'string') {
          return name
        }
        next.name = name
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
      if (patch.lead !== undefined && this.#joining.has(id) && joined === undefined) {
        return { status: 409, error: `${agent.name} is joining a team` }
      }
      if (patch.lead === null) {
        delete next.lead
        delete next.remoteLead
      } else if (patch.lead !== undefined) {
        if (typeof patch.lead !== 'string') {
          return { status: 400, error: 'lead must be an agent id or null' }
        }
        const leadId = this.localId(patch.lead)
        if (this.remoteGateway(leadId)) {
          if (joined?.lead !== leadId || this.#joining.get(id)?.lead !== leadId) {
            return { status: 409, error: 'a lead on another gateway is joined through the relay' }
          }
          if (this.hasMembers(id)) {
            return { status: 409, error: `${agent.name} leads a team; teams are one level deep` }
          }
          next.lead = joined.lead
          next.remoteLead = joined.remoteLead
        } else {
          const refused = this.leadRefusal(agent, leadId)
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
      return next
    })
    return updated.then((result) => {
      if (!isAgentRefusal(result) && result.lead !== previous) {
        options.onLeadChanged?.(previous)
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
      const crew = this.members(id)
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
      return { retired, released }
    })
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
    const stored = { ...agent, updatedAt: this.#now() }
    await this.#apply([stored], [])
    this.#agents.set(stored.id, stored)
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
