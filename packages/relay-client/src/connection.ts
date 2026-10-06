import { WebSocket, type RawData } from 'ws'
import {
  RELAY_CLOSE,
  RELAY_FRAME_MAX_BYTES,
  RELAY_OPS,
  RELAY_WIRE_VERSION,
  decodeFrame,
  encodeFrame,
  isRelayFeature,
  isRelayOp,
  isTeamFrameKind,
  type GatewayFrame,
  type RelayFeature,
  type RelayOp,
  type RelayOrigin,
  type RelayPeek,
  type RelayPeerRow,
  type RelaySendResult,
  type RelaySessionEntry,
  type RelayTarget,
  type RelayTeamOrigin,
  type TeamEdge,
  type TeamFrameKind,
  type TeamResult,
  type TeamStatusEdge,
} from './frames.ts'
import { createRegistryPublisher } from './registry.ts'

export type RelayHost = {
  snapshot(): Promise<RelaySessionEntry[]>
  peek(origin: RelayOrigin, sessionId: string, recent?: number): Promise<RelayPeek | undefined>
  send(origin: RelayOrigin, sessionId: string, text: string): Promise<RelaySendResult>
  team?(kind: TeamFrameKind, origin: RelayTeamOrigin, agentId: string): Promise<TeamResult>
  teamStatus?(origin: { gateway: string; owner: string }, edges: TeamEdge[]): Promise<Array<Omit<TeamStatusEdge, 'from' | 'to'>>>
  online?(): void
}

export type RelayConnectOptions = {
  url: string
  gateway: string
  key: string
  allow?: readonly RelayOp[]
  features?: readonly RelayFeature[]
  ca?: string | Buffer
  tickMs?: number
  digestMs?: number
  heartbeatMs?: number
  requestTimeoutMs?: number
  backoffMinMs?: number
  backoffMaxMs?: number
  log?: (message: string) => void
}

export type RelayState = 'connecting' | 'online' | 'offline' | 'stopped'

export type RelayConnection = {
  state(): RelayState
  list(from: string): Promise<RelayPeerRow[]>
  peek(from: string, to: RelayTarget, recent?: number): Promise<RelayPeek | undefined>
  send(from: string, to: RelayTarget, text: string, hops: string[]): Promise<RelaySendResult>
  team(kind: TeamFrameKind, from: string, to: string): Promise<TeamResult>
  teamStatus(gateway: string, edges: TeamEdge[]): Promise<TeamStatusEdge[]>
  features(): RelayFeature[]
  owner(): string | undefined
  nudge(): void
  setHost(host: RelayHost): void
  close(): void
}

export class RelayUnavailableError extends Error {
  constructor(message = 'remote gateways unavailable') {
    super(message)
    this.name = 'RelayUnavailableError'
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }

const TERMINAL_CLOSES: ReadonlyMap<number, string> = new Map([
  [RELAY_CLOSE.unauthorized, 'the relay refused this gateway key'],
  [RELAY_CLOSE.revoked, 'this gateway is not enrolled at the relay'],
  [RELAY_CLOSE.versionMismatch, 'the relay speaks a different wire version'],
  [RELAY_CLOSE.badHello, 'the relay refused the hello frame'],
])

export function connectRelay(options: RelayConnectOptions, initialHost: RelayHost): RelayConnection {
  const tickMs = options.tickMs ?? 2_000
  const digestMs = options.digestMs ?? 30_000
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const backoffMin = options.backoffMinMs ?? 1_000
  const backoffMax = options.backoffMaxMs ?? 60_000
  const allow = new Set<RelayOp>((options.allow ?? RELAY_OPS).filter(isRelayOp))
  const ownFeatures = [...new Set((options.features ?? []).filter(isRelayFeature))]
  const log = options.log ?? (() => {})

  let host = initialHost
  let state: RelayState = 'connecting'
  let socket: WebSocket | undefined
  let attempt = 0
  let reconnectTimer: NodeJS.Timeout | undefined
  let tickTimer: NodeJS.Timeout | undefined
  let digestTimer: NodeJS.Timeout | undefined
  let heartbeatTimer: NodeJS.Timeout | undefined
  let lastHeard = 0
  let ticking = false
  let tickAgain = false
  let nextId = 0
  let lastTerminal: number | undefined
  let publisher = createRegistryPublisher()
  let agreed: RelayFeature[] = []
  let ownOwner: string | undefined
  const pending = new Map<string, Pending>()

  const sendFrame = (frame: GatewayFrame): void => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(encodeFrame(frame))
    }
  }

  const failPending = (reason: string): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(new RelayUnavailableError(reason))
      pending.delete(id)
    }
  }

  const stopTimers = (): void => {
    clearInterval(tickTimer)
    clearInterval(digestTimer)
    clearInterval(heartbeatTimer)
    tickTimer = digestTimer = heartbeatTimer = undefined
  }

  const publishSnapshot = async (): Promise<void> => {
    const entries = await host.snapshot()
    if (state === 'online') {
      sendFrame(publisher.snapshot(entries))
    }
  }

  const tick = async (): Promise<void> => {
    if (state !== 'online') {
      return
    }
    if (ticking) {
      tickAgain = true
      return
    }
    ticking = true
    try {
      const entries = await host.snapshot()
      const delta = state === 'online' ? publisher.delta(entries) : undefined
      if (delta) {
        sendFrame(delta)
      }
    } catch (error) {
      log(`relay: registry tick failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      ticking = false
      if (tickAgain) {
        tickAgain = false
        void tick()
      }
    }
  }

  const answer = async (id: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      sendFrame({ t: 'res', id, ok: true, result: (await work()) ?? null })
    } catch (error) {
      sendFrame({ t: 'res', id, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const onInboundTeam = (frame: { t: string; [key: string]: unknown }): void => {
    const id = typeof frame.id === 'string' ? frame.id : undefined
    const origin = frame.origin as Partial<RelayTeamOrigin> | undefined
    if (!id || typeof origin?.gateway !== 'string' || typeof origin.owner !== 'string') {
      return
    }
    const open = allow.has('team') && agreed.includes('teams')
    if (frame.t === 'team.status') {
      const edges = Array.isArray(frame.edges) ? (frame.edges as TeamEdge[]) : []
      const handler = host.teamStatus
      void answer(id, async () => (open && handler ? handler({ gateway: origin.gateway!, owner: origin.owner! }, edges) : []))
      return
    }
    const to = typeof frame.to === 'string' ? frame.to : undefined
    const handler = host.team
    if (!isTeamFrameKind(frame.t) || typeof origin.agent !== 'string' || !to || !open || !handler) {
      void answer(id, async () => ({ ok: false, reason: 'no such agent' }) satisfies TeamResult)
      return
    }
    void answer(id, () => handler(frame.t as TeamFrameKind, origin as RelayTeamOrigin, to))
  }

  const onInbound = (frame: { t: string; [key: string]: unknown }): void => {
    const id = typeof frame.id === 'string' ? frame.id : undefined
    const origin = frame.origin as RelayOrigin | undefined
    const to = typeof frame.to === 'string' ? frame.to : undefined
    if (!id || !origin || typeof origin.gateway !== 'string' || typeof origin.sessionId !== 'string' || !to) {
      return
    }
    const hops = Array.isArray(origin.hops) ? origin.hops.filter((hop): hop is string => typeof hop === 'string') : []
    const stamped: RelayOrigin = { ...origin, hops }
    if (frame.t === 'peer.peek') {
      if (!allow.has('peek')) {
        void answer(id, async () => null)
        return
      }
      const recent = typeof frame.recent === 'number' ? frame.recent : undefined
      void answer(id, () => host.peek(stamped, to, recent))
      return
    }
    if (frame.t === 'peer.send') {
      if (!allow.has('send')) {
        void answer(id, async () => ({ delivered: false, reason: `no such session: ${to}` }))
        return
      }
      const text = typeof frame.text === 'string' ? frame.text : ''
      void answer(id, () => host.send(stamped, to, text))
    }
  }

  const onFrame = (raw: RawData): void => {
    lastHeard = Date.now()
    const frame = decodeFrame(Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? Buffer.from(raw) : raw)
    if (!frame) {
      return
    }
    switch (frame.t) {
      case 'welcome': {
        if (state !== 'connecting') {
          return
        }
        state = 'online'
        agreed = Array.isArray(frame.features) ? ownFeatures.filter((feature) => (frame.features as unknown[]).includes(feature)) : []
        ownOwner = typeof frame.owner === 'string' ? frame.owner : undefined
        attempt = 0
        lastTerminal = undefined
        log(`relay: connected to ${options.url} as ${options.gateway}`)
        publisher = createRegistryPublisher()
        void publishSnapshot().catch((error) => log(`relay: snapshot failed: ${error instanceof Error ? error.message : String(error)}`))
        tickTimer = setInterval(() => void tick(), tickMs)
        digestTimer = setInterval(() => sendFrame(publisher.digest()), digestMs)
        host.online?.()
        return
      }
      case 'registry.resync': {
        void publishSnapshot().catch(() => {})
        return
      }
      case 'res': {
        const id = typeof frame.id === 'string' ? frame.id : ''
        const entry = pending.get(id)
        if (!entry) {
          return
        }
        pending.delete(id)
        clearTimeout(entry.timer)
        if (frame.ok === true) {
          entry.resolve(frame.result)
        } else {
          entry.reject(new Error(typeof frame.error === 'string' ? frame.error : 'relay request failed'))
        }
        return
      }
      case 'peer.peek':
      case 'peer.send': {
        if (state === 'online') {
          onInbound(frame)
        }
        return
      }
      case 'team.join':
      case 'team.leave':
      case 'team.release':
      case 'team.invite':
      case 'team.request':
      case 'team.status': {
        if (state === 'online') {
          onInboundTeam(frame)
        }
        return
      }
    }
  }

  const scheduleReconnect = (): void => {
    if (state === 'stopped') {
      return
    }
    attempt += 1
    const ceiling = lastTerminal !== undefined ? backoffMax : Math.min(backoffMax, backoffMin * 2 ** (attempt - 1))
    const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
    reconnectTimer = setTimeout(dial, delay)
  }

  const onClose = (code: number, reason: string): void => {
    stopTimers()
    socket = undefined
    failPending('remote gateways unavailable')
    if (state === 'stopped') {
      return
    }
    const wasOnline = state === 'online'
    state = 'offline'
    const terminal = TERMINAL_CLOSES.get(code)
    if (terminal) {
      if (lastTerminal !== code) {
        log(`relay: ${terminal}${reason ? ` (${reason})` : ''}; retrying every ${Math.round(backoffMax / 1000)}s`)
      }
      lastTerminal = code
    } else if (wasOnline) {
      log(`relay: connection lost (${code}${reason ? ` ${reason}` : ''}); reconnecting`)
    }
    scheduleReconnect()
  }

  function dial(): void {
    reconnectTimer = undefined
    if (state === 'stopped') {
      return
    }
    state = 'connecting'
    const ws = new WebSocket(options.url, { maxPayload: RELAY_FRAME_MAX_BYTES, handshakeTimeout: requestTimeoutMs, ca: options.ca })
    socket = ws
    lastHeard = Date.now()
    ws.on('open', () => {
      sendFrame({
        t: 'hello',
        gateway: options.gateway,
        key: options.key,
        version: RELAY_WIRE_VERSION,
        ceiling: { ops: [...allow] },
        ...(ownFeatures.length > 0 ? { features: ownFeatures } : {}),
      })
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastHeard > heartbeatMs * 2 + 1_000) {
          ws.terminate()
          return
        }
        ws.ping()
      }, heartbeatMs)
    })
    ws.on('message', onFrame)
    ws.on('pong', () => {
      lastHeard = Date.now()
    })
    ws.on('ping', () => {
      lastHeard = Date.now()
    })
    ws.on('error', () => {})
    ws.on('close', (code, reason) => {
      if (socket === ws) {
        onClose(code, reason.toString('utf8'))
      }
    })
  }

  const request = <T>(frame: GatewayFrame & { id: string }): Promise<T> => {
    if (state !== 'online') {
      return Promise.reject(new RelayUnavailableError())
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(frame.id)
        reject(new RelayUnavailableError('the relay did not answer in time'))
      }, requestTimeoutMs)
      pending.set(frame.id, { resolve: resolve as (value: unknown) => void, reject, timer })
      sendFrame(frame)
    })
  }

  const newId = (): string => `g${++nextId}`

  const teamsAgreed = (): Promise<void> =>
    state === 'online' && !agreed.includes('teams')
      ? Promise.reject(new RelayUnavailableError('the relay does not route teams'))
      : Promise.resolve()

  dial()

  return {
    state: () => state,
    list: (from) => request<RelayPeerRow[]>({ t: 'peer.list', id: newId(), from }),
    peek: async (from, to, recent) => (await request<RelayPeek | null>({ t: 'peer.peek', id: newId(), from, to, recent })) ?? undefined,
    send: (from, to, text, hops) => request<RelaySendResult>({ t: 'peer.send', id: newId(), from, to, text, hops }),
    team: (kind, from, to) => teamsAgreed().then(() => request<TeamResult>({ t: kind, id: newId(), from, to })),
    teamStatus: (gateway, edges) => teamsAgreed().then(() => request<TeamStatusEdge[]>({ t: 'team.status', id: newId(), gateway, edges })),
    features: () => (state === 'online' ? [...agreed] : []),
    owner: () => ownOwner,
    nudge: () => void tick(),
    setHost: (next) => {
      host = next
    },
    close: () => {
      state = 'stopped'
      clearTimeout(reconnectTimer)
      stopTimers()
      failPending('relay connection closed')
      socket?.close(1000, 'gateway closing')
      socket = undefined
    },
  }
}
