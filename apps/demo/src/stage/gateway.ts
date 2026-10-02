import { WorkerDeckClient } from '@workerdeck/client'
import {
  ENGINE_CAPABILITIES,
  PROTOCOL_VERSION,
  contextReading,
  sessionState,
  transcriptActivity,
  transcriptProse,
} from '@workerdeck/protocol'
import type {
  ClientFrame,
  McpServerStatusInfo,
  PeerSessionSummary,
  ProfileInfo,
  ServerFrame,
  SessionEvent,
  SessionEventBody,
  SessionInfo,
  SessionRow,
  SessionStatus,
  ToolResultBlock,
} from '@workerdeck/protocol'

import type { Beat, Cue } from './tape.ts'

export type SessionSeed = {
  info: Omit<Partial<SessionInfo>, 'id' | 'cwd'> & { id: string; cwd: string }
  history?: Beat
  startedAgo?: number
  mcpServers?: McpServerStatusInfo[]
}

export type GatewayOptions = {
  speed?: number
  profiles?: ProfileInfo[]
  hostName?: string
}

export type CommandEvent = { sessionId: string; frame: ClientFrame }

type CommandListener = (command: CommandEvent) => boolean | void

type Track = {
  seed: SessionSeed
  info: SessionInfo
  log: SessionEvent[]
  pending: Set<string>
  seen: number
}

const HOST_ID = 'demo'
const CONNECTING = 0
const OPEN = 1
const CLOSED = 3
const DEFAULT_STARTED_AGO_MS = 20 * 60_000

export class DemoGateway {
  readonly client: WorkerDeckClient
  readonly hostId = HOST_ID
  readonly #tracks = new Map<string, Track>()
  readonly #order: string[] = []
  readonly #sockets = new Set<DemoSocket>()
  readonly #timers = new Set<ReturnType<typeof setTimeout>>()
  readonly #rowListeners = new Set<() => void>()
  readonly #commandListeners: CommandListener[] = []
  readonly #profiles: ProfileInfo[]
  readonly #hostName: string
  #speed: number
  #rows: SessionRow[] = []
  #disposed = false

  constructor(seeds: readonly SessionSeed[], options: GatewayOptions = {}) {
    this.#speed = options.speed ?? 1
    this.#profiles = options.profiles ?? []
    this.#hostName = options.hostName ?? 'local'
    for (const seed of seeds) {
      this.#add(seed)
    }
    this.#rows = this.#buildRows()
    this.client = new WorkerDeckClient({
      baseUrl: 'http://demo.invalid',
      WebSocketImpl: socketClassFor(this),
      fetchImpl: (input, init) => Promise.resolve(this.#route(init?.method ?? 'GET', requestUrl(input))),
    })
  }

  get speed(): number {
    return this.#speed
  }

  set speed(value: number) {
    this.#speed = value
  }

  sessionIds(): readonly string[] {
    return this.#order
  }

  session(id: string): SessionInfo {
    return this.#track(id).info
  }

  rows(): SessionRow[] {
    return this.#rows
  }

  subscribe(listener: () => void): () => void {
    this.#rowListeners.add(listener)
    return () => {
      this.#rowListeners.delete(listener)
    }
  }

  markSeen(id: string): void {
    const track = this.#track(id)
    const prose = track.info.proseCount ?? 0
    if (track.seen !== prose) {
      track.seen = prose
      this.#publish()
    }
  }

  addSession(seed: SessionSeed): void {
    this.#add(seed)
    this.#publish()
  }

  apply(id: string, cue: Cue): void {
    if (this.#disposed) {
      return
    }
    const track = this.#track(id)
    if ('patch' in cue) {
      track.info = { ...track.info, ...cue.patch }
    } else {
      const event = { ...cue.event, seq: track.log.length + 1, ts: Date.now() } as SessionEvent
      track.log.push(event)
      fold(track, event)
      for (const socket of this.#sockets) {
        if (socket.sessionId === id && socket.readyState === OPEN) {
          socket.push({ type: 'event', event })
        }
      }
    }
    this.#publish()
  }

  play(id: string, beat: Beat, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let index = 0
      let waited = false
      const next = (): void => {
        if (signal?.aborted || this.#disposed) {
          resolve()
          return
        }
        while (index < beat.length) {
          const cue = beat[index]!
          if (cue.gap > 0 && !waited) {
            waited = true
            this.#after(cue.gap / this.#speed, next)
            return
          }
          waited = false
          index += 1
          this.apply(id, cue)
        }
        resolve()
      }
      next()
    })
  }

  onCommand(listener: CommandListener): () => void {
    this.#commandListeners.unshift(listener)
    return () => {
      const at = this.#commandListeners.indexOf(listener)
      if (at !== -1) {
        this.#commandListeners.splice(at, 1)
      }
    }
  }

  waitForCommand(match: (command: CommandEvent) => boolean, signal?: AbortSignal): Promise<CommandEvent> {
    return new Promise<CommandEvent>((resolve, reject) => {
      const stop = this.onCommand((command) => {
        if (!match(command)) {
          return false
        }
        stop()
        resolve(command)
        return true
      })
      signal?.addEventListener('abort', () => {
        stop()
        reject(signal.reason)
      })
    })
  }

  dispose(): void {
    this.#disposed = true
    for (const timer of this.#timers) {
      clearTimeout(timer)
    }
    this.#timers.clear()
    for (const socket of this.#sockets) {
      socket.close()
    }
    this.#rowListeners.clear()
  }

  receive(socket: DemoSocket, frame: ClientFrame): void {
    const command = { sessionId: socket.sessionId, frame }
    for (const listener of this.#commandListeners.slice()) {
      if (listener(command) === true) {
        return
      }
    }
  }

  register(socket: DemoSocket): void {
    this.#track(socket.sessionId)
    this.#sockets.add(socket)
  }

  forget(socket: DemoSocket): void {
    this.#sockets.delete(socket)
  }

  admit(socket: DemoSocket): void {
    const track = this.#track(socket.sessionId)
    const cursor = track.log.length
    socket.push({ type: 'attached', protocolVersion: PROTOCOL_VERSION, session: this.#snapshot(track), replayingFrom: socket.afterSeq })
    if (socket.afterSeq > cursor) {
      return
    }
    for (const event of track.log.slice(socket.afterSeq)) {
      socket.push({ type: 'event', event })
    }
  }

  #add(seed: SessionSeed): void {
    const startedAgo = seed.startedAgo ?? DEFAULT_STARTED_AGO_MS
    const engine = seed.info.engine ?? 'claude'
    const createdAt = Date.now() - startedAgo
    const track: Track = {
      seed,
      info: {
        status: 'idle' as SessionStatus,
        capabilities: ENGINE_CAPABILITIES[engine],
        pendingPermissionCount: 0,
        activityCount: 0,
        proseCount: 0,
        numTurns: 0,
        totalCostUsd: 0,
        ...seed.info,
        engine,
        createdAt,
        lastActivityAt: createdAt,
        lastSeq: 0,
      },
      log: [],
      pending: new Set(),
      seen: 0,
    }
    this.#tracks.set(seed.info.id, track)
    this.#order.push(seed.info.id)
    let at = createdAt
    for (const cue of seed.history ?? []) {
      at += cue.gap
      if ('patch' in cue) {
        track.info = { ...track.info, ...cue.patch }
        continue
      }
      const event = { ...cue.event, seq: track.log.length + 1, ts: Math.min(at, Date.now()) } as SessionEvent
      track.log.push(event)
      fold(track, event)
    }
    track.seen = track.info.proseCount ?? 0
  }

  #track(id: string): Track {
    const track = this.#tracks.get(id)
    if (!track) {
      throw new Error(`demo gateway: no session '${id}'`)
    }
    return track
  }

  #snapshot(track: Track): SessionInfo {
    return { ...track.info, lastSeq: track.log.length, pendingPermissionCount: track.pending.size }
  }

  #buildRows(): SessionRow[] {
    return this.#order.map((id) => {
      const track = this.#track(id)
      const info = this.#snapshot(track)
      return {
        hostId: HOST_ID,
        hostName: this.#hostName,
        local: true,
        adapter: info.engine ?? 'claude',
        state: sessionState(info),
        info,
        unseen: Math.max(0, (info.proseCount ?? 0) - track.seen),
      }
    })
  }

  #publish(): void {
    this.#rows = this.#buildRows()
    for (const listener of this.#rowListeners) {
      listener()
    }
  }

  #after(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.#timers.delete(timer)
      run()
    }, ms)
    this.#timers.add(timer)
  }

  #route(method: string, url: string): Response {
    const path = new URL(url).pathname.replace(/^\/v1/, '')
    const match = /^\/sessions\/([^/]+)(\/.*)?$/.exec(path)
    const id = match ? decodeURIComponent(match[1]!) : undefined
    const rest = match?.[2] ?? ''
    const track = id ? this.#tracks.get(id) : undefined
    if (method === 'GET') {
      if (path === '/profiles') {
        return respond(200, { profiles: this.#profiles, canManage: false })
      }
      if (path === '/sessions') {
        return respond(200, { sessions: this.#order.map((sid) => this.#snapshot(this.#track(sid))) })
      }
      if (track && rest === '') {
        return respond(200, { session: this.#snapshot(track) })
      }
      if (track && rest === '/peers') {
        const peers = this.#order.filter((sid) => sid !== id).map((sid) => peerRow(this.#snapshot(this.#track(sid))))
        return respond(200, { peers })
      }
      if (track && rest === '/mcp') {
        return respond(200, { servers: track.seed.mcpServers ?? [] })
      }
      if (track && rest.startsWith('/events/') && rest.endsWith('/result')) {
        const seq = Number(rest.slice('/events/'.length, -'/result'.length))
        return toolResult(track, seq, new URL(url).searchParams.get('toolUseId') ?? '')
      }
      if (path === '/fs/find') {
        return respond(200, { matches: [] })
      }
    }
    return respond(404, { error: `demo: no route for ${method} ${path}` })
  }
}

export class DemoSocket {
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = CONNECTING
  readonly sessionId: string
  readonly afterSeq: number
  readonly #gateway: DemoGateway

  constructor(gateway: DemoGateway, url: string) {
    const parsed = new URL(url)
    const match = /\/sessions\/([^/]+)\/ws$/.exec(parsed.pathname)
    if (!match) {
      throw new Error(`demo gateway: unexpected socket url ${parsed.pathname}`)
    }
    this.#gateway = gateway
    this.sessionId = decodeURIComponent(match[1]!)
    this.afterSeq = Number(parsed.searchParams.get('afterSeq') ?? '0') || 0
    gateway.register(this)
    // SessionHandle assigns its handlers right after `new`, so opening must wait a microtask.
    queueMicrotask(() => this.#open())
  }

  send(payload: string): void {
    this.#gateway.receive(this, JSON.parse(payload) as ClientFrame)
  }

  close(): void {
    if (this.readyState === CLOSED) {
      return
    }
    this.readyState = CLOSED
    this.#gateway.forget(this)
    queueMicrotask(() => this.onclose?.())
  }

  push(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  #open(): void {
    if (this.readyState !== CONNECTING) {
      return
    }
    this.readyState = OPEN
    this.onopen?.()
    this.#gateway.admit(this)
  }
}

function socketClassFor(gateway: DemoGateway): typeof WebSocket {
  return class extends DemoSocket {
    constructor(url: string) {
      super(gateway, url)
    }
  } as unknown as typeof WebSocket
}

function fold(track: Track, event: SessionEvent): void {
  const body: SessionEventBody = event
  const info = { ...track.info }
  info.activityCount = (info.activityCount ?? 0) + transcriptActivity(body)
  info.proseCount = (info.proseCount ?? 0) + transcriptProse(body)
  info.lastActivityAt = event.ts
  info.lastSeq = event.seq
  switch (body.type) {
    case 'system_init': {
      info.sdkSessionId = body.sdkSessionId
      info.model = body.model
      info.permissionMode = body.permissionMode
      break
    }
    case 'status_changed': {
      info.status = body.status
      break
    }
    case 'model_changed': {
      info.model = body.model ?? info.model
      break
    }
    case 'permission_mode_changed': {
      info.permissionMode = body.mode
      break
    }
    case 'turn_result': {
      info.totalCostUsd = body.totalCostUsd
      info.numTurns = body.numTurns
      break
    }
    case 'context_usage': {
      info.contextUsage = contextReading(body)
      break
    }
    case 'checklist': {
      info.checklist = body.items.length > 0 ? body.items : undefined
      break
    }
    case 'permission_requested': {
      track.pending.add(body.request.id)
      break
    }
    case 'permission_resolved': {
      track.pending.delete(body.requestId)
      break
    }
    default: {
      break
    }
  }
  info.pendingPermissionCount = track.pending.size
  track.info = info
}

function toolResult(track: Track, seq: number, toolUseId: string): Response {
  const event = track.log[seq - 1]
  if (event?.type !== 'user_message' || typeof event.message.content === 'string') {
    return respond(404, { error: `demo: seq ${seq} carries no tool result` })
  }
  const block = event.message.content.find(
    (candidate): candidate is ToolResultBlock =>
      candidate.type === 'tool_result' && (candidate as ToolResultBlock).tool_use_id === toolUseId,
  )
  if (!block) {
    return respond(404, { error: `demo: seq ${seq} has no result for ${toolUseId}` })
  }
  return respond(200, { seq, toolUseId, content: block.content, isError: block.is_error === true })
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') {
    return input
  }
  return input instanceof URL ? input.href : input.url
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function peerRow(info: SessionInfo): PeerSessionSummary {
  return {
    id: info.id,
    engine: info.engine,
    status: info.status,
    title: info.title,
    project: info.project?.name,
    projectRoot: info.project?.root,
    cwd: info.cwd,
    model: info.model,
    lastActivityAt: info.lastActivityAt,
    pendingPermissionCount: info.pendingPermissionCount,
  }
}
