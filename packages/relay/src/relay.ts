import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import { unwatchFile, watchFile } from 'node:fs'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  RELAY_CLOSE,
  RELAY_FRAME_MAX_BYTES,
  RELAY_MAX_HOPS,
  RELAY_MESSAGE_MAX_CHARS,
  RELAY_WIRE_VERSION,
  canonicalJson,
  decodeFrame,
  encodeFrame,
  isRelayOp,
  parseRelayPeerId,
  registryHash,
  relayPeerId,
  type InboundPeek,
  type InboundSend,
  type RelayFrame,
  type RelayOp,
  type RelayOrigin,
  type RelayPeerRow,
  type RelaySendResult,
  type RelaySessionEntry,
} from '@workerdeck/relay-client'
import { enrollmentPath, keyMatches, readEnrollments, type EnrollmentFile } from './enrollment.ts'
import { allowedOps, readRules, rulesPath, type RelayRule } from './rules.ts'

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
  log?: (line: string) => void
}

export type RelayGatewayStatus = { name: string; online: boolean; sessions: number; connectedAt?: number; ops: RelayOp[] }

export type RelayStatus = { version: number; gateways: RelayGatewayStatus[] }

export type Relay = {
  url: string
  port: number
  status(): RelayStatus
  reload(): Promise<void>
  close(): Promise<void>
}

type Gateway = {
  name: string
  socket: WebSocket
  ops: Set<RelayOp>
  connectedAt: number
  seq: number
  entries: Map<string, RelaySessionEntry>
  json: Map<string, string>
  missed: number
}

type Routed = { gateway: string; timer: NodeJS.Timeout; settle: (frame: { ok: boolean; result?: unknown; error?: string }) => void }

type Frame = { t: string; [key: string]: unknown }

const WINDOW_MS = 60_000

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
      }
    }
  }

  const underRateLimit = (key: string): boolean => {
    const now = Date.now()
    const recent = (sent.get(key) ?? []).filter((at) => now - at < WINDOW_MS)
    const ok = recent.length < perMinute
    if (ok) {
      recent.push(now)
    }
    sent.set(key, recent)
    return ok
  }

  const route = (target: Gateway, frame: Omit<InboundPeek, 'id'> | Omit<InboundSend, 'id'>): Promise<unknown> => {
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

  const visible = (from: Gateway, target: Gateway, entry: RelaySessionEntry): RelayOp[] =>
    target === from ? [] : allowedOps(rules, from.name, target.name, entry, target.ops)

  const list = (from: Gateway): RelayPeerRow[] => {
    const rows: RelayPeerRow[] = []
    for (const target of gateways.values()) {
      for (const entry of target.entries.values()) {
        const allow = visible(from, target, entry)
        if (allow.length > 0) {
          rows.push({ ...entry, gateway: target.name, allow })
        }
      }
    }
    return rows.sort((a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt))
  }

  const resolveTarget = (from: Gateway, to: unknown, op: RelayOp): { target: Gateway; entry: RelaySessionEntry } | undefined => {
    const where = to as { gateway?: unknown; id?: unknown } | undefined
    if (typeof where?.gateway !== 'string' || typeof where.id !== 'string') {
      return undefined
    }
    const target = gateways.get(where.gateway)
    const entry = target?.entries.get(where.id)
    if (!target || !entry || !visible(from, target, entry).includes(op)) {
      return undefined
    }
    return { target, entry }
  }

  const peerRequest = async (from: Gateway, frame: Frame): Promise<unknown> => {
    const sender = typeof frame.from === 'string' ? from.entries.get(frame.from) : undefined
    if (frame.t === 'peer.list') {
      return sender ? list(from) : []
    }
    const to = frame.to as { gateway?: string; id?: string } | undefined
    const label = `${to?.gateway ?? '?'}:${to?.id ?? '?'}`
    if (frame.t === 'peer.peek') {
      const found = sender && resolveTarget(from, frame.to, 'peek')
      if (!found) {
        return null
      }
      const recent = typeof frame.recent === 'number' ? frame.recent : undefined
      return route(found.target, { t: 'peer.peek', origin: originOf(from, sender, []), to: found.entry.id, recent })
    }
    const text = typeof frame.text === 'string' ? frame.text : ''
    const found = sender && resolveTarget(from, frame.to, 'send')
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
        gateway.entries = new Map(entries.map((entry) => [entry.id, entry]))
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
          gateway.entries.set(entry.id, entry)
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
        peerRequest(gateway, frame).then(
          (result) => send(gateway.socket, { t: 'res', id, ok: true, result: result ?? null }),
          (error: unknown) =>
            send(gateway.socket, { t: 'res', id, ok: false, error: error instanceof Error ? error.message : String(error) }),
        )
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
    const previous = gateways.get(name)
    if (previous) {
      drop(previous, RELAY_CLOSE.replaced, 'replaced by a newer connection')
    }
    const gateway: Gateway = {
      name,
      socket,
      ops: new Set(Array.isArray(ceiling) ? ceiling.filter(isRelayOp) : []),
      connectedAt: Date.now(),
      seq: 0,
      entries: new Map(),
      json: new Map(),
      missed: 0,
    }
    gateways.set(name, gateway)
    log(`relay: ${name} online`)
    send(socket, { t: 'welcome', relayVersion: RELAY_WIRE_VERSION })
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

  const serveStatus = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.url !== '/status' || req.method !== 'GET' || !isLoopback(req.socket.remoteAddress)) {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(status()))
  }

  const status = (): RelayStatus => {
    const names = new Set([...Object.keys(enrollments.gateways), ...gateways.keys()])
    return {
      version: RELAY_WIRE_VERSION,
      gateways: [...names].sort().map((name) => {
        const gateway = gateways.get(name)
        return gateway
          ? { name, online: true, sessions: gateway.entries.size, connectedAt: gateway.connectedAt, ops: [...gateway.ops] }
          : { name, online: false, sessions: 0, ops: [] }
      }),
    }
  }

  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, serveStatus)
    : createHttpServer(serveStatus)
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 7777, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
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
    },
  }
}

function send(socket: WebSocket, frame: RelayFrame): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(encodeFrame(frame))
  }
}

function originOf(from: Gateway, sender: RelaySessionEntry, hops: string[]): RelayOrigin {
  return { gateway: from.name, sessionId: sender.id, name: sender.title, engine: sender.engine, hops }
}
