import { randomUUID } from 'node:crypto'
import {
  AGENT_SLEEP_AFTER_MS_DEFAULT,
  agentRef,
  type AgentConfig,
  type AgentInfo,
  type SessionInfo,
  type UpdateAgentRequest,
} from '@workerdeck/protocol'
import type { AgentStore, StoredAgent } from './agent-store.ts'

export type AgentServiceOptions = {
  store: AgentStore
  basePath: string
  now?: () => number
}

export type AgentRefusal = { status: number; error: string }

export type RetireOutcome = { retired: StoredAgent[]; released: StoredAgent[] }

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
  #now: () => number
  #agents = new Map<string, StoredAgent>()

  constructor(options: AgentServiceOptions) {
    this.#store = options.store
    this.#basePath = options.basePath
    this.#now = options.now ?? Date.now
  }

  async hydrate(): Promise<void> {
    this.#agents = new Map((await this.#store.list()).map((agent) => [agent.id, agent]))
  }

  list(): AgentInfo[] {
    return [...this.#agents.values()].map(publicAgent)
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
    const leadName = agent.lead === undefined ? undefined : this.#agents.get(agent.lead)?.name
    return { ...info, agent: agentRef(agent, { leadName, leads: this.hasMembers(agent.id) }) }
  }

  briefFor(sessionId: string | undefined): string | undefined {
    const brief = sessionId === undefined ? undefined : this.bySession(sessionId)?.config.brief?.trim()
    return brief || undefined
  }

  sleepAfterFor(sessionId: string): number | undefined {
    const agent = this.bySession(sessionId)
    return agent ? (agent.config.sleepAfterMs ?? AGENT_SLEEP_AFTER_MS_DEFAULT) : undefined
  }

  public(agent: StoredAgent): AgentInfo {
    return publicAgent(agent)
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
      avatar: `${this.#basePath}/agents/${id}/avatar.png`,
      avatarSeed: id,
      pastSessions: [],
      config,
    }
    if (input.lead !== undefined && input.lead !== null) {
      const refused =
        typeof input.lead === 'string' ? this.leadRefusal(agent, input.lead) : { status: 400, error: 'lead must be an agent id' }
      if (refused) {
        return refused
      }
      agent.lead = input.lead as string
    }
    return agent
  }

  async save(agent: StoredAgent): Promise<StoredAgent> {
    const stored = { ...agent, updatedAt: this.#now() }
    await this.#store.save(stored)
    this.#agents.set(stored.id, stored)
    return stored
  }

  async bind(agent: StoredAgent, sessionId: string): Promise<StoredAgent> {
    const past =
      agent.sessionId !== undefined && agent.sessionId !== sessionId ? [...agent.pastSessions, agent.sessionId] : agent.pastSessions
    return this.save({ ...agent, sessionId, pastSessions: past })
  }

  hasMembers(id: string): boolean {
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
    const lead = this.#agents.get(leadId)
    if (!lead) {
      return { status: 404, error: `no such agent: ${leadId}` }
    }
    if (lead.lead !== undefined) {
      return { status: 409, error: `${lead.name} is a member of a team; teams are one level deep` }
    }
    if (this.hasMembers(mover.id)) {
      return { status: 409, error: `${mover.name} leads a team; teams are one level deep` }
    }
    return null
  }

  async update(id: string, patch: UpdateAgentRequest): Promise<StoredAgent | AgentRefusal> {
    const agent = this.#agents.get(id)
    if (!agent) {
      return { status: 404, error: `no such agent: ${id}` }
    }
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
    if (patch.lead === null) {
      delete next.lead
    } else if (patch.lead !== undefined) {
      if (typeof patch.lead !== 'string') {
        return { status: 400, error: 'lead must be an agent id or null' }
      }
      const refused = this.leadRefusal(agent, patch.lead)
      if (refused) {
        return refused
      }
      next.lead = patch.lead
    }
    if (patch.order !== undefined) {
      if (typeof patch.order !== 'number' || !Number.isFinite(patch.order)) {
        return { status: 400, error: 'order must be a number' }
      }
      next.order = patch.order
    }
    return this.save(next)
  }

  async retire(id: string, members: 'release' | 'retire'): Promise<RetireOutcome | AgentRefusal> {
    const agent = this.#agents.get(id)
    if (!agent) {
      return { status: 404, error: `no such agent: ${id}` }
    }
    const crew = this.members(id)
    const retired = [agent, ...(members === 'retire' ? crew : [])]
    const released: StoredAgent[] = []
    if (members === 'release') {
      for (const member of crew) {
        const { lead: _lead, ...rest } = member
        released.push(await this.save(rest))
      }
    }
    for (const gone of retired) {
      await this.#store.delete(gone.id)
      this.#agents.delete(gone.id)
    }
    return { retired, released }
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

export function isAgentRefusal(value: unknown): value is AgentRefusal {
  return isRecord(value) && typeof value.status === 'number' && typeof value.error === 'string'
}

function publicAgent(agent: StoredAgent): AgentInfo {
  const { avatarSeed: _seed, avatarRecipe: _recipe, ...info } = agent
  return info
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
