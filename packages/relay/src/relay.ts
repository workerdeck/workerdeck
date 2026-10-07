import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { unwatchFile, watchFile } from 'node:fs'
import { rm } from 'node:fs/promises'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  RELAY_CLOSE,
  RELAY_FRAME_MAX_BYTES,
  RELAY_MAX_HOPS,
  RELAY_MESSAGE_MAX_CHARS,
  RELAY_WIRE_VERSION,
  RELAY_FEATURES,
  canonicalJson,
  decodeFrame,
  encodeFrame,
  isRelayFeature,
  isRelayOp,
  isTeamFrameKind,
  parseRelayPeerId,
  qualifyId,
  registryHash,
  relayPeerId,
  type InboundPeek,
  type InboundSend,
  type InboundTeam,
  type InboundTeamStatus,
  type RelayFeature,
  type RelayFrame,
  type RelayOp,
  type RelayOrigin,
  type RelayPeerRow,
  type RelaySendResult,
  type RelaySessionEntry,
  type TeamEdge,
  type TeamResult,
  type TeamStatusAnswer,
  type TeamStatusEdge,
  type TeamSeen,
  readTeamOp,
  readTeamRosters,
  readTeamSeen,
} from '@workerdeck/relay-client'
import { enrollmentPath, keyMatches, ownersOf, readEnrollments, type EnrollmentFile } from './enrollment.ts'
import { allowedOps, readRules, rulesPath, type RelayRule } from './rules.ts'
import { serveStatusSocket, statusSocketPath } from './status.ts'
import { accessOps, projectCard, projectForOtherOwner, sanitizeEntry, teamAllows, type TeamAccess, type TeamNode } from './teams.ts'

export type RelayOptions = {
  stateDir: string
  host?: string
  port?: number
  tls?: { cert: string | Buffer; key: string | Buffer }
  requestTimeoutMs?: number
  heartbeatMs?: number
  helloTimeoutMs?: number
  perMinute?: number
  maxHops?: number
  maxMessageChars?: number
  watchIntervalMs?: number
  owner?: string
  teamPerMinute?: number
  invitesPerDay?: number
  log?: (line: string) => void
}

export const DEFAULT_RELAY_OWNER = 'operator'

export type RelayGatewayStatus = {
  name: string
  owner: string
  owners: string[]
  online: boolean
  sessions: number
  connectedAt?: number
  ops: RelayOp[]
  features: RelayFeature[]
}

export type RelayStatus = { version: number; gateways: RelayGatewayStatus[] }

export type Relay = {
  url: string
  port: number
  status(): RelayStatus
  reload(): Promise<void>
  close(): Promise<void>
}

// `owners` is the enrolled set; every entry and team frame names one of them (`ownerOf`).
type Gateway = {
  name: string
  owners: string[]
  socket: WebSocket
  ops: Set<RelayOp>
  features: Set<RelayFeature>
  connectedAt: number
  seq: number
  entries: Map<string, RelaySessionEntry>
  json: Map<string, string>
  missed: number
}

type Routed = { gateway: string; timer: NodeJS.Timeout; settle: (frame: { ok: boolean; result?: unknown; error?: string }) => void }

type Frame = { t: string; [key: string]: unknown }

type Outbound = Omit<InboundPeek, 'id'> | Omit<InboundSend, 'id'> | Omit<InboundTeam, 'id'> | Omit<InboundTeamStatus, 'id'>

const WINDOW_MS = 60_000
const DAY_MS = 24 * 60 * 60_000
const MAX_STATUS_EDGES = 64
const NO_SUCH_AGENT: TeamResult = { ok: false, reason: 'no such agent' }

function notFound(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(404).end()
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function readEntries(value: unknown): RelaySessionEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const entries = value.filter(
    (entry): entry is RelaySessionEntry =>
      typeof entry === 'object' && entry !== null && typeof entry.id === 'string' && entry.id.length > 0 && typeof entry.cwd === 'string',
  )
  return entries.length === value.length ? entries : undefined
}

export async function startRelay(options: RelayOptions): Promise<Relay> {
  const log = options.log ?? ((line: string) => console.log(line))
  const requestTimeoutMs = options.requestTimeoutMs ?? 8_000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const helloTimeoutMs = options.helloTimeoutMs ?? 10_000
  const perMinute = options.perMinute ?? 10
  const maxHops = options.maxHops ?? RELAY_MAX_HOPS
  const maxChars = options.maxMessageChars ?? RELAY_MESSAGE_MAX_CHARS
  const watchIntervalMs = options.watchIntervalMs ?? 2_000
  const defaultOwner = options.owner ?? DEFAULT_RELAY_OWNER
  const teamPerMinute = options.teamPerMinute ?? 30
  const invitesPerDay = options.invitesPerDay ?? 10

  let enrollments: EnrollmentFile = await readEnrollments(options.stateDir)
  let rules: RelayRule[] = await readRules(options.stateDir)
  const gateways = new Map<string, Gateway>()
  const routed = new Map<string, Routed>()
  const sent = new Map<string, number[]>()
  let nextId = 0

  const drop = (gateway: Gateway, code: number, reason: string): void => {
    if (gateways.get(gateway.name) === gateway) {
      gateways.delete(gateway.name)
      for (const [id, entry] of routed) {
        if (entry.gateway === gateway.name) {
          clearTimeout(entry.timer)
          routed.delete(id)
          entry.settle({ ok: false, error: `gateway ${gateway.name} went offline` })
        }
      }
      log(`relay: ${gateway.name} offline (${reason})`)
    }
    if (gateway.socket.readyState === gateway.socket.OPEN || gateway.socket.readyState === gateway.socket.CONNECTING) {
      gateway.socket.close(code, reason)
    }
  }

  const reload = async (): Promise<void> => {
    try {
      enrollments = await readEnrollments(options.stateDir)
    } catch (error) {
      log(`relay: keeping the previous enrollments, ${enrollmentPath(options.stateDir)} is unreadable: ${String(error)}`)
    }
    try {
      rules = await readRules(options.stateDir)
    } catch (error) {
      log(
        `relay: keeping the previous rules, ${rulesPath(options.stateDir)} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    for (const gateway of gateways.values()) {
      if (!enrollments.gateways[gateway.name]) {
        drop(gateway, RELAY_CLOSE.revoked, 'revoked')
        continue
      }
      gateway.owners = ownersOf(enrollments.gateways[gateway.name], defaultOwner)
      if (gateway.owners.length > 1 && !gateway.features.has('owners')) {
        drop(gateway, RELAY_CLOSE.ownersRequired, 'several owners need a gateway that names them')
      }
    }
  }

  const enrolledOwners = (name: string): string[] => ownersOf(enrollments.gateways[name], defaultOwner)

  // Which owner a frame about `agent` speaks for: its published entry's, else the claim, which must be enrolled.
  const claimOwner = (gateway: Gateway, agent: string, claimed: unknown): string | undefined => {
    const published = findAgent(agent)
    if (published) {
      const owner = ownerOf(published.gateway, published.entry)
      return claimed === undefined || claimed === owner ? owner : undefined
    }
    if (typeof claimed === 'string' && gateway.features.has('owners')) {
      return gateway.owners.includes(claimed) ? claimed : undefined
    }
    return gateway.owners.length === 1 ? gateway.owners[0] : undefined
  }

  const underRateLimit = (key: string, limit = perMinute, windowMs = WINDOW_MS): boolean => {
    const now = Date.now()
    const recent = (sent.get(key) ?? []).filter((at) => now - at < windowMs)
    const ok = recent.length < limit
    if (ok) {
      recent.push(now)
    }
    sent.set(key, recent)
    return ok
  }

  const route = (target: Gateway, frame: Outbound): Promise<unknown> => {
    const id = `r${++nextId}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        routed.delete(id)
        reject(new Error(`gateway ${target.name} did not answer in time`))
      }, requestTimeoutMs)
      routed.set(id, {
        gateway: target.name,
        timer,
        settle: (res) => (res.ok ? resolve(res.result) : reject(new Error(res.error ?? 'request failed'))),
      })
      send(target.socket, { ...frame, id } as RelayFrame)
    })
  }

  const findAgent = (qualifiedId: string): { gateway: Gateway; entry: RelaySessionEntry } | undefined => {
    const target = parseRelayPeerId(qualifiedId)
    const gateway = target ? gateways.get(target.gateway) : undefined
    if (!gateway) {
      return undefined
    }
    for (const entry of gateway.entries.values()) {
      if (entry.agent?.id === qualifiedId && ownerOf(gateway, entry) !== undefined) {
        return { gateway, entry }
      }
    }
    return undefined
  }

  const lookup = (qualifiedId: string): TeamNode | undefined => {
    const found = findAgent(qualifiedId)
    return found ? nodeOf(found.gateway, found.entry) : undefined
  }

  const opsBetween = (from: Gateway, fromOwner: string, target: Gateway, entry: RelaySessionEntry, targetOwner: string): RelayOp[] =>
    target === from ? [] : allowedOps(rules, from.name, target.name, entry, target.ops, fromOwner !== targetOwner)

  const access = (
    from: Gateway,
    sender: RelaySessionEntry,
    target: Gateway,
    entry: RelaySessionEntry,
  ): { access: TeamAccess; ops: RelayOp[] } => {
    const a = nodeOf(from, sender)
    const b = nodeOf(target, entry)
    if (!a || !b) {
      return { access: 'none', ops: [] }
    }
    const allowed = teamAllows(a, b, lookup)
    const ops = opsBetween(from, a.owner, target, entry, b.owner).filter((op) => op !== 'team')
    return { access: allowed, ops: accessOps(allowed, ops, a, b) }
  }

  const visible = (from: Gateway, sender: RelaySessionEntry, target: Gateway, entry: RelaySessionEntry): RelayOp[] =>
    access(from, sender, target, entry).ops

  const list = (from: Gateway, sender: RelaySessionEntry): RelayPeerRow[] => {
    const rows: RelayPeerRow[] = []
    const mine = ownerOf(from, sender)
    for (const target of gateways.values()) {
      for (const entry of target.entries.values()) {
        const seen = access(from, sender, target, entry)
        const owner = ownerOf(target, entry)
        if (seen.ops.length > 0 && owner !== undefined) {
          const shown = owner === mine ? entry : seen.access === 'message' ? projectCard(entry) : projectForOtherOwner(entry)
          rows.push({ ...shown, gateway: target.name, owner, allow: seen.ops })
        }
      }
    }
    return rows.sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
  }

  const resolveTarget = (
    from: Gateway,
    sender: RelaySessionEntry,
    to: unknown,
    op: RelayOp,
  ): { target: Gateway; entry: RelaySessionEntry } | undefined => {
    const where = to as { gateway?: unknown; id?: unknown } | undefined
    if (typeof where?.gateway !== 'string' || typeof where.id !== 'string') {
      return undefined
    }
    const target = gateways.get(where.gateway)
    const entry = target?.entries.get(where.id)
    if (!target || !entry || !visible(from, sender, target, entry).includes(op)) {
      return undefined
    }
    return { target, entry }
  }

  const teamTarget = (
    from: Gateway,
    fromOwner: string,
    to: unknown,
  ): { target: Gateway; entry: RelaySessionEntry; owner: string } | undefined => {
    const found = typeof to === 'string' ? findAgent(to) : undefined
    const owner = found ? ownerOf(found.gateway, found.entry) : undefined
    if (!found || owner === undefined || found.gateway === from || !found.gateway.features.has('teams')) {
      return undefined
    }
    return opsBetween(from, fromOwner, found.gateway, found.entry, owner).includes('team')
      ? { target: found.gateway, entry: found.entry, owner }
      : undefined
  }

  const teamRequest = async (from: Gateway, frame: Frame): Promise<unknown> => {
    const kind = frame.t
    if (!isTeamFrameKind(kind)) {
      return NO_SUCH_AGENT
    }
    const quiet = kind === 'team.invite' || kind === 'team.request'
    const miss = quiet ? ({ ok: true } satisfies TeamResult) : NO_SUCH_AGENT
    const agent =
      typeof frame.from === 'string' && frame.from && !parseRelayPeerId(frame.from) ? qualifyId(from.name, frame.from) : undefined
    const owner = agent ? claimOwner(from, agent, frame.owner) : undefined
    const found = agent && owner !== undefined ? teamTarget(from, owner, frame.to) : undefined
    if (!agent || owner === undefined || !found) {
      return miss
    }
    if (!underRateLimit(`team:${from.name}->${found.target.name}`, teamPerMinute)) {
      return quiet ? miss : ({ ok: false, reason: `rate limit: at most ${teamPerMinute} team requests a minute` } satisfies TeamResult)
    }
    if (quiet && !underRateLimit(`invite:${owner}->${found.owner}`, invitesPerDay, DAY_MS)) {
      return miss
    }
    const name = findAgent(agent)?.entry.agent?.name
    const op = readTeamOp(frame.op)
    const delivery = route(found.target, {
      t: kind,
      origin: { gateway: from.name, owner, agent, ...(name ? { name } : {}) },
      to: found.entry.agent!.id.slice(found.target.name.length + 1),
      ...(op === undefined ? {} : { op }),
    })
    if (quiet) {
      delivery.catch(() => {})
      return miss
    }
    const result = (await delivery) as Partial<{ ok: unknown }> | null
    return result?.ok === true ? { ...result, owner: found.owner } : result
  }

  const teamStatus = async (from: Gateway, frame: Frame): Promise<TeamStatusAnswer> => {
    const target = typeof frame.gateway === 'string' ? gateways.get(frame.gateway) : undefined
    if (!target || target === from || !target.features.has('teams') || !Array.isArray(frame.edges)) {
      throw new Error('unreachable')
    }
    if (!underRateLimit(`team:${from.name}->${target.name}`, teamPerMinute)) {
      throw new Error('rate limit')
    }
    const edges: TeamEdge[] = []
    for (const raw of frame.edges.slice(0, MAX_STATUS_EDGES) as Array<Partial<TeamEdge> | null>) {
      if (typeof raw?.from !== 'string' || !raw.from || parseRelayPeerId(raw.from) || typeof raw.to !== 'string') {
        continue
      }
      const remote = parseRelayPeerId(raw.to)
      const owner = claimOwner(from, qualifyId(from.name, raw.from), raw.owner)
      if (remote?.gateway !== target.name || owner === undefined) {
        continue
      }
      const found = findAgent(raw.to)
      const entry = found?.entry ?? { id: '', status: 'idle', cwd: '', createdAt: 0, pendingPermissionCount: 0, live: false }
      // An agent with no row (asleep, or gone) is judged by whether its gateway could claim the asking owner at all.
      const targetOwner = found ? ownerOf(target, found.entry)! : target.owners.includes(owner) ? owner : ''
      if (opsBetween(from, owner, target, entry, targetOwner).includes('team')) {
        const op = readTeamOp(raw.op)
        edges.push({ from: raw.from, to: raw.to, owner, ...(op === undefined ? {} : { op }) })
      }
    }
    if (edges.length === 0) {
      return { edges: [] }
    }
    const answer = (await route(target, {
      t: 'team.status',
      origin: { gateway: from.name, owner: from.owners[0]! },
      edges: edges.map((edge) => ({ ...edge, from: qualifyId(from.name, edge.from), to: parseRelayPeerId(edge.to)!.id })),
      rosters: readTeamRosters(frame.rosters, from.name),
      seen: seenOf(frame.seen, target.name),
    })) as Partial<Record<keyof TeamStatusAnswer, unknown>> | null
    const rows = Array.isArray(answer?.edges) ? (answer.edges as Array<Partial<TeamStatusEdge> | null>) : []
    const rosters = readTeamRosters(answer?.rosters, target.name)
    const seen = seenOf(answer?.seen, from.name)
    const answered = edges.flatMap(({ owner: _owner, ...edge }, index) => {
      const row = rows[index]
      if (typeof row?.known !== 'boolean') {
        return []
      }
      return [
        {
          ...edge,
          known: row.known,
          ...(typeof row.name === 'string' ? { name: row.name } : {}),
          ...(typeof row.session === 'string' ? { session: row.session } : {}),
        },
      ]
    })
    return { edges: answered, ...(rosters.length > 0 ? { rosters } : {}), ...(seen.length > 0 ? { seen } : {}) }
  }

  const peerRequest = async (from: Gateway, frame: Frame): Promise<unknown> => {
    const published = typeof frame.from === 'string' ? from.entries.get(frame.from) : undefined
    const sender = published && ownerOf(from, published) !== undefined ? published : undefined
    if (frame.t === 'peer.list') {
      return sender ? list(from, sender) : []
    }
    const to = frame.to as { gateway?: string; id?: string } | undefined
    const label = `${to?.gateway ?? '?'}:${to?.id ?? '?'}`
    if (frame.t === 'peer.peek') {
      const found = sender && resolveTarget(from, sender, frame.to, 'peek')
      if (!found) {
        return null
      }
      const recent = typeof frame.recent === 'number' ? frame.recent : undefined
      const owner = ownerOf(found.target, found.entry)
      const peek = await route(found.target, { t: 'peer.peek', origin: originOf(from, sender, []), to: found.entry.id, recent })
      return peek && typeof peek === 'object' ? { ...peek, owner } : peek
    }
    const text = typeof frame.text === 'string' ? frame.text : ''
    const found = sender && resolveTarget(from, sender, frame.to, 'send')
    if (!found || !sender) {
      return { delivered: false, reason: `no such session: ${label}` } satisfies RelaySendResult
    }
    if (text.length === 0 || text.length > maxChars) {
      return {
        delivered: false,
        reason: `message is ${text.length} characters; the limit is ${maxChars}. Write it to a file and send the path.`,
      }
    }
    const hops = (Array.isArray(frame.hops) ? frame.hops : [])
      .filter((hop): hop is string => typeof hop === 'string')
      .map((hop) => (parseRelayPeerId(hop) ? hop : relayPeerId(from.name, hop)))
    if (hops.length > maxHops) {
      return {
        delivered: false,
        reason: `${hops.length} messages have passed between sessions without a person speaking; stop and ask your user before continuing.`,
      }
    }
    if (!underRateLimit(`${relayPeerId(from.name, sender.id)}->${relayPeerId(found.target.name, found.entry.id)}`)) {
      return { delivered: false, reason: `rate limit: at most ${perMinute} messages a minute to one session. Batch what you have to say.` }
    }
    return route(found.target, { t: 'peer.send', origin: originOf(from, sender, hops), to: found.entry.id, text })
  }

  const onGatewayFrame = (gateway: Gateway, frame: Frame): void => {
    switch (frame.t) {
      case 'registry.snapshot': {
        const entries = readEntries(frame.entries)
        if (!entries || typeof frame.seq !== 'number') {
          return
        }
        gateway.entries = new Map(entries.map((entry) => [entry.id, sanitizeEntry(gateway.name, entry)]))
        gateway.json = new Map(entries.map((entry) => [entry.id, canonicalJson(entry)]))
        gateway.seq = frame.seq
        return
      }
      case 'registry.delta': {
        const upsert = readEntries(frame.upsert)
        const remove = Array.isArray(frame.remove) ? frame.remove.filter((id): id is string => typeof id === 'string') : undefined
        if (!upsert || !remove || frame.seq !== gateway.seq + 1) {
          send(gateway.socket, { t: 'registry.resync' })
          return
        }
        for (const id of remove) {
          gateway.entries.delete(id)
          gateway.json.delete(id)
        }
        for (const entry of upsert) {
          gateway.entries.set(entry.id, sanitizeEntry(gateway.name, entry))
          gateway.json.set(entry.id, canonicalJson(entry))
        }
        gateway.seq = frame.seq
        return
      }
      case 'registry.digest': {
        if (frame.seq !== gateway.seq) {
          return
        }
        if (frame.count !== gateway.entries.size || frame.hash !== registryHash(gateway.json)) {
          log(`relay: ${gateway.name} registry drifted; asking for a snapshot`)
          send(gateway.socket, { t: 'registry.resync' })
        }
        return
      }
      case 'res': {
        const id = typeof frame.id === 'string' ? frame.id : ''
        const entry = routed.get(id)
        if (!entry || entry.gateway !== gateway.name) {
          return
        }
        routed.delete(id)
        clearTimeout(entry.timer)
        entry.settle({ ok: frame.ok === true, result: frame.result, error: typeof frame.error === 'string' ? frame.error : undefined })
        return
      }
      case 'peer.list':
      case 'peer.peek':
      case 'peer.send': {
        const id = typeof frame.id === 'string' ? frame.id : undefined
        if (!id) {
          return
        }
        respond(gateway, id, peerRequest(gateway, frame))
        return
      }
      case 'team.join':
      case 'team.leave':
      case 'team.release':
      case 'team.invite':
      case 'team.request':
      case 'team.status': {
        const id = typeof frame.id === 'string' ? frame.id : undefined
        if (!id || !gateway.features.has('teams')) {
          return
        }
        respond(gateway, id, frame.t === 'team.status' ? teamStatus(gateway, frame) : teamRequest(gateway, frame))
        return
      }
    }
  }

  const onHello = (socket: WebSocket, frame: Frame): Gateway | undefined => {
    const name = typeof frame.gateway === 'string' ? frame.gateway : ''
    if (frame.t !== 'hello' || !name || typeof frame.key !== 'string') {
      socket.close(RELAY_CLOSE.badHello, 'expected hello')
      return undefined
    }
    if (frame.version !== RELAY_WIRE_VERSION) {
      socket.close(RELAY_CLOSE.versionMismatch, `relay speaks wire version ${RELAY_WIRE_VERSION}`)
      return undefined
    }
    const enrollment = enrollments.gateways[name]
    if (!keyMatches(enrollment, frame.key)) {
      log(`relay: refused a hello for ${JSON.stringify(name.slice(0, 64))}`)
      socket.close(RELAY_CLOSE.unauthorized, 'unauthorized')
      return undefined
    }
    const ceiling = (frame.ceiling as { ops?: unknown } | undefined)?.ops
    const features = Array.isArray(frame.features) ? frame.features.filter(isRelayFeature) : []
    const owners = enrolledOwners(name)
    if (owners.length > 1 && !features.includes('owners')) {
      log(`relay: refused ${name}: it is enrolled with several owners and cannot name them`)
      socket.close(RELAY_CLOSE.ownersRequired, 'several owners need a gateway that names them')
      return undefined
    }
    const previous = gateways.get(name)
    if (previous) {
      drop(previous, RELAY_CLOSE.replaced, 'replaced by a newer connection')
    }
    const gateway: Gateway = {
      name,
      owners,
      socket,
      ops: new Set(Array.isArray(ceiling) ? ceiling.filter(isRelayOp) : []),
      features: new Set(features),
      connectedAt: Date.now(),
      seq: 0,
      entries: new Map(),
      json: new Map(),
      missed: 0,
    }
    gateways.set(name, gateway)
    log(`relay: ${name} online`)
    send(socket, { t: 'welcome', relayVersion: RELAY_WIRE_VERSION, features: [...RELAY_FEATURES], owner: owners[0], owners })
    return gateway
  }

  const onConnection = (socket: WebSocket): void => {
    let gateway: Gateway | undefined
    const helloTimer = setTimeout(() => socket.close(RELAY_CLOSE.timeout, 'no hello'), helloTimeoutMs)
    socket.on('message', (raw: RawData) => {
      const frame = decodeFrame(Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw)
      if (gateway) {
        gateway.missed = 0
        if (frame) {
          onGatewayFrame(gateway, frame)
        }
        return
      }
      clearTimeout(helloTimer)
      gateway = frame ? onHello(socket, frame) : undefined
      if (!gateway && socket.readyState === socket.OPEN) {
        socket.close(RELAY_CLOSE.badHello, 'expected hello')
      }
    })
    socket.on('pong', () => {
      if (gateway) {
        gateway.missed = 0
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      clearTimeout(helloTimer)
      if (gateway) {
        drop(gateway, 1000, 'disconnected')
      }
    })
  }

  const status = (): RelayStatus => {
    const names = new Set([...Object.keys(enrollments.gateways), ...gateways.keys()])
    return {
      version: RELAY_WIRE_VERSION,
      gateways: [...names].sort().map((name) => {
        const gateway = gateways.get(name)
        const owners = enrolledOwners(name)
        const owner = owners[0]!
        return gateway
          ? {
              name,
              owner,
              owners,
              online: true,
              sessions: gateway.entries.size,
              connectedAt: gateway.connectedAt,
              ops: [...gateway.ops],
              features: [...gateway.features],
            }
          : { name, owner, owners, online: false, sessions: 0, ops: [], features: [] }
      }),
    }
  }

  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, notFound)
    : createHttpServer(notFound)
  const wss = new WebSocketServer({ server, maxPayload: RELAY_FRAME_MAX_BYTES })
  wss.on('connection', onConnection)

  const heartbeat = setInterval(() => {
    for (const gateway of gateways.values()) {
      gateway.missed += 1
      if (gateway.missed > 2) {
        drop(gateway, RELAY_CLOSE.timeout, 'heartbeat')
        gateway.socket.terminate()
        continue
      }
      gateway.socket.ping()
    }
  }, heartbeatMs)
  heartbeat.unref()

  const watched = [enrollmentPath(options.stateDir), rulesPath(options.stateDir)]
  for (const path of watched) {
    watchFile(path, { interval: watchIntervalMs, persistent: false }, () => void reload())
  }

  const host = options.host ?? '127.0.0.1'
  const statusServer = await serveStatusSocket(options.stateDir, status)
  const closeStatus = async (): Promise<void> => {
    await new Promise<void>((resolve) => statusServer.close(() => resolve()))
    await rm(statusSocketPath(options.stateDir), { force: true })
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port ?? 7777, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await closeStatus()
    throw error
  }
  const port = (server.address() as AddressInfo).port
  const scheme = options.tls ? 'wss' : 'ws'
  const url = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`
  if (!options.tls && !isLoopback(host) && host !== 'localhost') {
    log(`relay: serving plain ws:// on ${host}; gateway keys cross the network unencrypted unless this is a tailnet or a TLS proxy`)
  }

  return {
    url,
    port,
    status,
    reload,
    close: async () => {
      clearInterval(heartbeat)
      for (const path of watched) {
        unwatchFile(path)
      }
      for (const gateway of gateways.values()) {
        drop(gateway, 1001, 'relay shutting down')
      }
      for (const client of wss.clients) {
        client.terminate()
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await closeStatus()
    },
  }
}

function send(socket: WebSocket, frame: RelayFrame): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(encodeFrame(frame))
  }
}

// The entry's owner when the gateway may claim it; a gateway enrolled with one owner speaks for it on every entry.
// Undefined leaves the entry out of every list, route and team decision, so a removed owner takes effect at reload.
function ownerOf(gateway: Gateway, entry: RelaySessionEntry): string | undefined {
  const claimed = gateway.features.has('owners') ? entry.owner : undefined
  if (claimed !== undefined) {
    return gateway.owners.includes(claimed) ? claimed : undefined
  }
  return gateway.owners.length === 1 ? gateway.owners[0] : undefined
}

function nodeOf(gateway: Gateway, entry: RelaySessionEntry): TeamNode | undefined {
  const owner = ownerOf(gateway, entry)
  return owner === undefined
    ? undefined
    : { gateway: gateway.name, owner, agent: entry.agent, ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}) }
}

function respond(gateway: Gateway, id: string, work: Promise<unknown>): void {
  work.then(
    (result) => send(gateway.socket, { t: 'res', id, ok: true, result: result ?? null }),
    (error: unknown) => send(gateway.socket, { t: 'res', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
  )
}

function originOf(from: Gateway, sender: RelaySessionEntry, hops: string[]): RelayOrigin {
  const agent = sender.agent
  return {
    gateway: from.name,
    owner: ownerOf(from, sender),
    sessionId: sender.id,
    name: agent?.name ?? sender.title,
    engine: sender.engine,
    ...(agent
      ? {
          agent: {
            id: agent.id,
            name: agent.name,
            ...(agent.lead ? { lead: agent.lead } : {}),
            ...(agent.shared ? { shared: true as const } : {}),
          },
        }
      : {}),
    hops,
  }
}

// A gateway may tell another only which revision it holds of that other gateway's own rosters.
function seenOf(value: unknown, about: string): TeamSeen[] {
  return readTeamSeen(value).filter((seen) => parseRelayPeerId(seen.lead)?.gateway === about)
}
