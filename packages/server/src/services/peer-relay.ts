import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { PeerDirectory, PeerPeek, PeerSendResult, PeerSessionSummary } from '@workerdeck/core'
import { qualifyAgent, teamReaches, type AgentRef, type ChecklistItem, type SessionInfo } from '@workerdeck/protocol'
import {
  connectRelay,
  parseRelayPeerId,
  type RelayAgentEntry,
  type RelayConnection,
  type RelayHost,
  type RelayOp,
  type RelayPeek,
  type RelayPeerRow,
  type RelayTeamOrigin,
  type TeamEdge,
  type TeamFrameKind,
  type TeamResult,
  type TeamStatusEdge,
} from '@workerdeck/relay-client'
import type { PeerService } from './peers.ts'

export type RelayLinkOptions = {
  url: string
  gateway: string
  key?: string
  keyFile?: string
  caFile?: string
  // The gateway ceiling. Sessions outside `scope` are never published and never answer a relay-routed request;
  // `allow` is what this gateway accepts from other gateways at all, whatever the relay's rules say.
  expose?: { scope?: Record<string, string>; allow?: RelayOp[] }
  // Cross-gateway teams: same-owner gateways whose agents may join a lead here without a per-join invitation.
  teams?: { acceptFrom?: string[] }
  log?: (message: string) => void
}

export type RelayTeamHandler = {
  inbound(kind: TeamFrameKind, origin: RelayTeamOrigin, to: string): Promise<TeamResult>
  inboundStatus(origin: { gateway: string; owner: string }, edges: TeamEdge[]): Promise<Array<Omit<TeamStatusEdge, 'from' | 'to'>>>
  reconcile(): Promise<void>
}

export type RelayLinkStatus = { gateway: string; owner?: string; online: boolean; features: string[] }

export type RelayLink = {
  directory: PeerDirectory
  gateway: string
  status(): RelayLinkStatus
  // Why team frames cannot go out right now, or undefined when they can.
  teamsUnavailable(): string | undefined
  team(kind: TeamFrameKind, from: string, to: string): Promise<TeamResult>
  teamStatus(gateway: string, edges: TeamEdge[]): Promise<TeamStatusEdge[]>
  nudge(): void
  // Hands the connection to the next module generation instead of closing it (hot reload).
  release(): void
  close(): void
}

type Carried = { identity: string; connection: RelayConnection }

// Keyed through `Symbol.for`, so the generation a hot reload builds finds what the old one released.
const CARRIED = Symbol.for('workerdeck.relay.carried')
const slots = globalThis as { [CARRIED]?: Carried }

const UNAVAILABLE = 'Remote gateways are unavailable right now; only sessions on this gateway are listed.'

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? `${homedir()}${path.slice(1)}` : path
}

function identityOf(options: RelayLinkOptions): string {
  return JSON.stringify([
    options.url,
    options.gateway,
    options.keyFile ?? '',
    options.key ? 'inline' : '',
    options.caFile ?? '',
    options.expose?.allow ?? null,
    options.teams ?? null,
  ])
}

// Ids on a relay row are already qualified by the relay.
function remoteRef(agent: RelayAgentEntry | undefined): AgentRef | undefined {
  return agent ? { id: agent.id, name: agent.name, ...(agent.lead !== undefined ? { lead: agent.lead } : {}) } : undefined
}

// A peek answer from an older gateway carries bare ids; the gateway it came from is the one it was asked.
function qualifyPeek(peek: RelayPeek, gateway: string): RelayPeek {
  const qualified = qualifyAgent(remoteRef(peek.agent), gateway)
  if (!peek.agent || !qualified) {
    return peek
  }
  return { ...peek, agent: { ...peek.agent, id: qualified.id, ...(qualified.lead !== undefined ? { lead: qualified.lead } : {}) } }
}

type TeamNames = { nameOf(agentId: string): string | undefined; leads: ReadonlySet<string> }

function teamFields(agent: RelayAgentEntry | undefined, names: TeamNames): Pick<PeerSessionSummary, 'agent' | 'role' | 'team'> {
  if (!agent) {
    return {}
  }
  if (agent.lead !== undefined) {
    const team = names.nameOf(agent.lead)
    return { agent: agent.name, role: 'member', ...(team !== undefined ? { team } : {}) }
  }
  const leads = (agent.accepts?.length ?? 0) > 0 || names.leads.has(agent.id)
  return leads ? { agent: agent.name, role: 'lead', team: agent.name } : { agent: agent.name }
}

const NO_NAMES: TeamNames = { nameOf: () => undefined, leads: new Set() }

function remoteSummary(row: RelayPeerRow, names: TeamNames = NO_NAMES): PeerSessionSummary {
  return {
    id: `${row.gateway}:${row.id}`,
    gateway: row.gateway,
    ...(row.owner !== undefined ? { owner: row.owner } : {}),
    engine: row.engine,
    status: row.status,
    title: row.title,
    project: row.project?.name,
    projectRoot: row.project?.root,
    cwd: row.cwd,
    profile: row.profile,
    model: row.model,
    contextUsage: row.contextUsage,
    lastActivityAt: row.lastActivityAt,
    pendingPermissionCount: row.pendingPermissionCount,
    allow: row.allow.filter((op) => op === 'send' || op === 'peek'),
    ...teamFields(row.agent, names),
  }
}

function remotePeek(gateway: string, peek: RelayPeek, names: TeamNames): PeerPeek {
  const { allow: _allow, ...summary } = remoteSummary({ ...peek, gateway, allow: [] }, names)
  return {
    ...summary,
    live: peek.live,
    checklist: peek.checklistItems as ChecklistItem[] | undefined,
    pendingApprovals: peek.pendingApprovals,
    recent: peek.recent,
  }
}

export async function readRelayKey(options: RelayLinkOptions): Promise<string> {
  if (options.key) {
    return options.key
  }
  if (!options.keyFile) {
    throw new Error('relay: set relay.keyFile (or WORKERDECK_RELAY_KEY) to the key `workerdeck relay enroll` printed')
  }
  const key = (await readFile(expandHome(options.keyFile), 'utf8')).trim()
  if (!key) {
    throw new Error(`relay: ${options.keyFile} is empty`)
  }
  return key
}

// The local peer directory with the relay composed in: bare ids stay local, `gateway:session` ids go to the relay.
// A scoped session never reaches past its own gateway, because nothing on the wire carries scope tags.
export function createRelayLink(
  options: RelayLinkOptions,
  peers: PeerService,
  log: (message: string) => void,
  teams?: () => RelayTeamHandler | undefined,
): RelayLink {
  const identity = identityOf(options)
  const exposed = options.expose?.scope
  let connection: RelayConnection | undefined
  let closed = false
  let released = false

  const teamsAgreed = (): boolean => connection?.features().includes('teams') === true

  const host: RelayHost = {
    snapshot: () => peers.relayEntries(exposed, teamsAgreed()),
    peek: (origin, sessionId, recent) => peers.relayPeek(origin, sessionId, recent, exposed, options.gateway),
    send: (origin, sessionId, text) => peers.relaySend(origin, sessionId, text, exposed, options.gateway),
    team: async (kind, origin, to) => (await teams?.()?.inbound(kind, origin, to)) ?? { ok: false, reason: 'no such agent' },
    teamStatus: async (origin, edges) => (await teams?.()?.inboundStatus(origin, edges)) ?? [],
    online: () => void teams?.()?.reconcile(),
  }

  const carried = slots[CARRIED]
  if (carried) {
    delete slots[CARRIED]
    if (carried.identity === identity && carried.connection.state() !== 'stopped') {
      carried.connection.setHost(host)
      connection = carried.connection
    } else {
      carried.connection.close()
    }
  }

  if (!connection) {
    void (async () => {
      const key = await readRelayKey(options)
      const ca = options.caFile ? await readFile(expandHome(options.caFile)) : undefined
      if (!closed) {
        connection = connectRelay(
          { url: options.url, gateway: options.gateway, key, ca, allow: options.expose?.allow, features: teams ? ['teams'] : [], log },
          host,
        )
      }
    })().catch((error: unknown) => log(error instanceof Error ? error.message : String(error)))
  }

  const remoteTarget = parseRelayPeerId

  // A scoped session never leaves its gateway; a member does only when its team spans gateways.
  const reacher = async (from: string): Promise<SessionInfo | undefined> => {
    const me = await peers.relaySender(from)
    const scoped = me.scope !== undefined && Object.keys(me.scope).length > 0
    return !scoped && (me.agent?.lead === undefined || (teamsAgreed() && peers.relaySpans(me.id))) ? me : undefined
  }
  const reachesRemote = async (from: string): Promise<boolean> => (await reacher(from)) !== undefined

  const localName = (agentId: string): string | undefined => {
    const target = parseRelayPeerId(agentId)
    return target?.gateway === options.gateway ? peers.relayAgentName(target.id) : undefined
  }

  // The relay already applied the team rule; the gateway applies it again to every row, after checking the row's team
  // claims against its own records, so a row the relay attributes to a team here must be one of that team's members.
  const admits = (mine: AgentRef | undefined, gateway: string, agent: AgentRef | undefined): boolean =>
    (agent === undefined || peers.relayVouches(agent, gateway)) && teamReaches(mine, agent)

  const teamRows = async (me: SessionInfo, from: string): Promise<{ rows: RelayPeerRow[]; names: TeamNames }> => {
    const mine = qualifyAgent(me.agent, options.gateway)
    const rows = (await connection!.list(from)).filter((row) => admits(mine, row.gateway, remoteRef(row.agent)))
    const byId = new Map(rows.flatMap((row) => (row.agent ? [[row.agent.id, row.agent.name] as const] : [])))
    const leads = new Set(rows.flatMap((row) => (row.agent?.lead !== undefined ? [row.agent.lead] : [])))
    return { rows, names: { nameOf: (id) => byId.get(id) ?? localName(id), leads } }
  }

  const directory: PeerDirectory = {
    list: async (from) => {
      const local = await peers.list(from)
      const me = connection?.state() === 'online' ? await reacher(from) : undefined
      if (!me) {
        return local
      }
      try {
        const { rows, names } = await teamRows(me, from)
        return [...local, ...rows.map((row) => remoteSummary(row, names))]
      } catch {
        return local
      }
    },
    notice: async (from) => {
      if (!(await reachesRemote(from))) {
        return undefined
      }
      return connection?.state() === 'online' ? undefined : UNAVAILABLE
    },
    peek: async (from, sessionId, peekOptions) => {
      const target = remoteTarget(sessionId)
      if (!target) {
        return peers.peek(from, sessionId, peekOptions)
      }
      const me = connection ? await reacher(from) : undefined
      if (!connection || !me) {
        return undefined
      }
      const answer = await connection.peek(from, target, peekOptions?.recent)
      if (!answer) {
        return undefined
      }
      const peek = qualifyPeek(answer, target.gateway)
      if (!admits(qualifyAgent(me.agent, options.gateway), target.gateway, remoteRef(peek.agent))) {
        return undefined
      }
      const names: TeamNames = { nameOf: (id) => localName(id), leads: new Set() }
      return remotePeek(target.gateway, peek, names)
    },
    send: async (from, sessionId, text, sendOptions): Promise<PeerSendResult> => {
      const target = remoteTarget(sessionId)
      if (!target) {
        return peers.send(from, sessionId, text, sendOptions)
      }
      const me = await reacher(from)
      if (!me) {
        return { delivered: false, reason: `no such session: ${sessionId}` }
      }
      if (!connection || connection.state() !== 'online') {
        return { delivered: false, reason: 'remote gateways are unavailable right now; try again later' }
      }
      if (me.agent?.lead !== undefined) {
        const { rows } = await teamRows(me, from).catch(() => ({ rows: [] as RelayPeerRow[] }))
        if (!rows.some((row) => row.gateway === target.gateway && row.id === target.id)) {
          return { delivered: false, reason: `no such session: ${sessionId}` }
        }
      }
      try {
        const result = await connection.send(from, target, text, sendOptions?.hops ?? peers.relayChain(from))
        return result.delivered ? { ...result, sessionId } : result
      } catch (error) {
        return { delivered: false, reason: error instanceof Error ? error.message : String(error) }
      }
    },
  }

  const teamsUnavailable = (): string | undefined => {
    if (!connection || connection.state() !== 'online') {
      return 'remote gateways are unavailable right now; try again later'
    }
    return connection.features().includes('teams') ? undefined : 'the relay does not route teams; upgrade it first'
  }

  return {
    directory,
    gateway: options.gateway,
    status: () => {
      const online = connection?.state() === 'online'
      const owner = connection?.owner()
      return { gateway: options.gateway, ...(owner ? { owner } : {}), online, features: online ? connection!.features() : [] }
    },
    teamsUnavailable,
    team: (kind, from, to) => (connection ? connection.team(kind, from, to) : Promise.reject(new Error(teamsUnavailable()))),
    teamStatus: (gateway, edges) =>
      connection ? connection.teamStatus(gateway, edges) : Promise.reject(new Error(teamsUnavailable())),
    nudge: () => connection?.nudge(),
    release: () => {
      if (connection && !closed) {
        released = true
        slots[CARRIED] = { identity, connection }
      }
    },
    close: () => {
      closed = true
      if (!released) {
        connection?.close()
      }
      connection = undefined
    },
  }
}
