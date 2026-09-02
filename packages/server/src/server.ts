import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getEngineAdapter } from '@workerdeck/core'
import type { EngineAdapter } from '@workerdeck/core'
import { JobQueue } from '@workerdeck/queue'
import {
  PROTOCOL_VERSION,
  sessionState,
  type CreateSessionRequest,
  type JobEvent,
  type ProfileEngine,
  type QueueServerFrame,
} from '@workerdeck/protocol'
import type { SessionRunnerConfig } from '@workerdeck/core'
import type { ServerContext } from './context.ts'
import { json } from './lib/http.ts'
import { detectDefaultProfiles } from './lib/profile-env.ts'
import { parseSessionRoute } from './lib/parse-route.ts'
import type { DrainReport, LateBoundRefs, WorkerServer, WorkerServerOptions } from './options.ts'
import { handleExecutionResult } from './routes/executions.ts'
import { handleHostFiles } from './routes/host-files.ts'
import { handleJobs } from './routes/jobs.ts'
import { handleProfiles } from './routes/profiles.ts'
import { handleSdkSessions } from './routes/sdk-sessions.ts'
import { handleSessions } from './routes/sessions.ts'
import { attachClient } from './routes/ws.ts'
import { AttachmentStore } from './services/attachments.ts'
import { createAuthService } from './services/auth.ts'
import { AvailabilityTracker } from './services/availability.ts'
import { BridgeHub } from './services/bridge.ts'
import { createHostFileRoots } from './services/host-files.ts'
import { SessionNotifier } from './services/notifications.ts'
import { SessionParkManager } from './services/parking.ts'
import { ProducedFileStore } from './services/produced-files.ts'
import { ProfileService } from './services/profiles.ts'
import { ProfileUsageTracker } from './services/profile-usage.ts'
import { ProjectInfoService } from './services/project-info.ts'
import { SessionRegistry } from './services/registry.ts'
import { createSessionFactory } from './services/session-factory.ts'
import { isDormant, MemorySessionStore } from './services/session-store.ts'

export type {
  Authenticator,
  EngineRunnerContext,
  QueueServerOptions,
  SdkSessionLister,
  WorkerServer,
  WorkerServerOptions,
} from './options.ts'

// How long a client gets to acknowledge the shutdown close frame before its socket is torn down.
const SOCKET_CLOSE_GRACE_MS = 250

// Split live sessions into "will finish by itself" and "needs a person".
//
// `sessionState` is the vocabulary the dashboard, the session list and `workerdeck guard` already sort by, and it
// draws exactly the line a drain needs: `working` covers starting/running and running subagents, while `attention`
// covers a pending approval. Re-spelling that set here is how the two definitions would drift apart.
function surveyDrain(registry: SessionRegistry): DrainReport {
  const working: string[] = []
  const awaitingHuman: string[] = []
  for (const info of registry.list()) {
    const state = sessionState(info)
    if (state === 'working') {
      working.push(info.id)
    } else if (state === 'attention') {
      awaitingHuman.push(info.id)
    }
  }
  return { working, awaitingHuman, timedOut: false }
}

function sameDrain(a: DrainReport, b: DrainReport): boolean {
  return a.working.join() === b.working.join() && a.awaitingHuman.join() === b.awaitingHuman.join()
}

export function createWorkerServer(options: WorkerServerOptions = {}): WorkerServer {
  if (!options.authenticate && !options.allowUnauthenticated) {
    throw new Error('createWorkerServer: provide `authenticate` or explicitly set `allowUnauthenticated: true`')
  }
  const basePath = options.basePath ?? '/v1'
  const fallback = options.fallback
  const corsOrigins = options.cors?.origins.length ? new Set(options.cors.origins) : undefined
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const adapterFor = (engine: ProfileEngine | undefined): EngineAdapter => options.engines?.[engine ?? 'claude'] ?? getEngineAdapter(engine)

  const profileDefaultModels = new Map<string, string>()
  const profileUsage = new ProfileUsageTracker()
  const profiles = new ProfileService({
    declared: options.profiles ?? detectDefaultProfiles(),
    store: options.profileStore,
    allowedConfigDirRoots: options.allowedConfigDirRoots,
    disableBypassPermissions: options.disableBypassPermissions,
    hasEngineRunnerFactory: options.createEngineRunner !== undefined,
    adapterFor,
    decorate: {
      defaultModel: (name) => profileDefaultModels.get(name),
      availability: (name) => availability.get(name),
      usage: (name) => profileUsage.usage(name),
    },
  })
  for (const p of options.profiles ?? []) {
    const invalid = profiles.validate(p)
    if (invalid) {
      throw new Error(`createWorkerServer: ${invalid}`)
    }
  }

  const refs: LateBoundRefs = {}
  const factory = createSessionFactory({
    adapterFor,
    profiles,
    hostBuildRunnerConfig: options.buildRunnerConfig ?? ((req: CreateSessionRequest): SessionRunnerConfig => req),
    createEngineRunner: options.createEngineRunner,
    allowedCwdRoots: options.allowedCwdRoots,
    disableBypassPermissions: options.disableBypassPermissions,
    requireApiKey: options.requireApiKey,
    refs,
  })

  const availability = new AvailabilityTracker({
    checkCredentials: options.checkCredentials,
    requireAvailableProfile: options.requireAvailableProfile,
    adapterFor,
    sessionEnvFor: factory.sessionEnvFor,
  })

  const projects = new ProjectInfoService()
  const notifier = new SessionNotifier({
    ...options.notifications,
    decorateInfo: (info) => projects.withProject(info),
  })
  const producedFiles = new ProducedFileStore()
  const registry = new SessionRegistry({
    onRegister: (runner) => {
      notifier.watch(runner)
      producedFiles.watch(runner)
      profileUsage.watch(runner)
      const profile = runner.info().profile
      if (!profile) {
        return
      }
      runner.subscribe((event) => {
        if (event.type !== 'capabilities' || !event.defaultModel) {
          return
        }
        profileDefaultModels.set(profile, event.defaultModel)
      })
    },
  })
  const attachmentStore = new AttachmentStore(options.attachments)
  const bridge = new BridgeHub({
    ...options.bridge,
    onResult: (sessionId, executionId, result) => {
      registry.get(sessionId)?.settleExecution?.(executionId, result)
      options.bridge?.onResult?.(sessionId, executionId, result)
    },
  })
  const parking = new SessionParkManager({
    registry,
    store: options.parking?.store ?? new MemorySessionStore(),
    parkDelayMs: options.parking?.parkDelayMs,
    expiredGraceMs: options.parking?.expiredGraceMs,
    persistLive: options.parking?.persistLive,
    onError: options.parking?.onError,
    rebuild: (record) =>
      isDormant(record)
        ? factory.buildRunner(
            factory.buildRunnerConfig({
              ...record.config,
              prompt: undefined,
              meta: record.info.title ? { ...record.config.meta, title: record.info.title } : record.config.meta,
              resume: record.sdkSessionId,
            }),
            undefined,
            record.id,
          )
        : factory.buildRunner(record.config, record.snapshot),
    attachedCount: (sessionId) => bridge.attachedCount(sessionId),
    onParking: (sessionId, executionId) => queue?.onSessionParking(sessionId, executionId) ?? true,
    onResumed: (sessionId, runner) => queue?.onSessionResumed(sessionId, runner),
  })
  refs.registry = registry
  refs.parking = parking
  refs.bridge = bridge

  const auth = createAuthService({ options, refs })

  const wss = new WebSocketServer({ noServer: true })
  let closing: Promise<void> | undefined
  let draining = false

  const queueSockets = new Set<WebSocket>()
  const sendQueueFrame = (ws: WebSocket, frame: QueueServerFrame): void => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame))
    }
  }
  const broadcastJobEvent = (event: JobEvent): void => {
    if (queueSockets.size === 0) {
      return
    }
    for (const ws of queueSockets) {
      sendQueueFrame(ws, { type: 'job_event', event })
    }
    if (event.type !== 'job_progress') {
      void queue
        ?.stats()
        .then((stats) => {
          for (const ws of queueSockets) {
            sendQueueFrame(ws, { type: 'queue_stats', stats })
          }
        })
        .catch(() => {})
    }
  }

  const queue = options.queue
    ? new JobQueue({
        ...options.queue,
        onEvent: (event) => {
          try {
            options.queue?.onEvent?.(event)
          } finally {
            broadcastJobEvent(event)
          }
        },
        createRunner: async (config) => {
          const runner = await factory.createRunner(config)
          factory.watchAuthSource(runner)
          return runner
        },
        buildRunnerConfig: factory.buildRunnerConfig,
        discardSession: (sessionId) => parking.discard(sessionId),
      })
    : undefined

  const hostFileRootPaths = options.hostFiles?.roots ?? options.allowedCwdRoots
  const hostFiles = hostFileRootPaths?.length ? createHostFileRoots(hostFileRootPaths) : null

  const ctx: ServerContext = {
    options,
    basePath,
    maxBodyBytes,
    adapterFor,
    listSdkSessions: options.listSdkSessions,
    profiles,
    availability,
    auth,
    factory,
    registry,
    parking,
    bridge,
    projects,
    queue,
    attachmentStore,
    producedFiles,
    hostFiles,
    hostFilesWritable: options.hostFiles?.write === true,
    maxHostFileBytes: options.hostFiles?.maxFileBytes ?? 1024 * 1024,
    maxHostDirEntries: options.hostFiles?.maxEntries ?? 5000,
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname

    const origin = req.headers.origin
    const originAllowed = typeof origin === 'string' && corsOrigins !== undefined && corsOrigins.has(origin)
    if (originAllowed) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    }
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      if (!originAllowed) {
        res.writeHead(403)
        res.end()
        return
      }
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PATCH, PUT, DELETE')
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-workerdeck-key')
      res.setHeader('access-control-max-age', '600')
      // Chrome's Private Network Access: a public page reaching a private address (a tailnet, a LAN) preflights for this explicitly.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('access-control-allow-private-network', 'true')
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (fallback && pathname !== basePath && !pathname.startsWith(basePath + '/')) {
      await fallback(req, res)
      return
    }
    if (pathname === basePath + '/jobs' || pathname.startsWith(basePath + '/jobs/') || pathname === basePath + '/queue') {
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleJobs(ctx, req, res, pathname, authCtx)
      return
    }
    if (pathname === basePath + '/profiles' || pathname.startsWith(basePath + '/profiles/')) {
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleProfiles(ctx, req, res, pathname, authCtx)
      return
    }
    if (pathname.startsWith(basePath + '/executions/')) {
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleExecutionResult(ctx, req, res, pathname, authCtx)
      return
    }
    if (pathname === basePath + '/sdk-sessions') {
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      if (!auth.isOperator(authCtx)) {
        json(res, 404, { error: 'not found' })
        return
      }
      await handleSdkSessions(ctx, req, res, authCtx)
      return
    }
    if (pathname.startsWith(basePath + '/fs/')) {
      // Authenticated before the 404-when-unconfigured answer: an unauthenticated caller must not learn whether a filesystem is exposed.
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      if (!auth.isOperator(authCtx)) {
        json(res, 404, { error: 'not found' })
        return
      }
      await handleHostFiles(ctx, req, res, pathname)
      return
    }
    const route = parseSessionRoute(basePath, req.url ?? '/')
    if (!route || route.ws) {
      json(res, 404, { error: 'not found' })
      return
    }
    // Starting a turn we have already promised to stop waiting for would make the drain unable to converge.
    // Existing sessions stay fully controllable — including approvals, which is how an operator unblocks one.
    if (draining && req.method === 'POST' && route.id === undefined) {
      json(res, 503, { error: 'server is shutting down' })
      return
    }
    const authCtx = await auth.authenticate(req)
    if (!authCtx.ok) {
      json(res, 401, { error: 'unauthorized' })
      return
    }
    await handleSessions(ctx, req, res, route, authCtx)
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error'
      if (!res.headersSent) {
        json(res, error instanceof SyntaxError ? 400 : 500, { error: message })
      } else {
        res.end()
      }
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://internal').pathname
      if (pathname === basePath + '/queue/ws') {
        if (!queue) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        const queueAuth = await auth.authenticate(req)
        if (!queueAuth.ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        if (!auth.isOperator(queueAuth)) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          queueSockets.add(ws)
          ws.on('close', () => queueSockets.delete(ws))
          void queue
            .stats()
            .then((stats) => sendQueueFrame(ws, { type: 'queue_attached', protocolVersion: PROTOCOL_VERSION, stats }))
            .catch(() => {})
        })
        return
      }
      const route = parseSessionRoute(basePath, req.url ?? '/')
      if (!route?.ws || !route.id) {
        socket.destroy()
        return
      }
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const known = registry.get(route.id)?.info() ?? (await parking.get(route.id))?.info
      if (known && !auth.canSee(authCtx, known)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const runner = await parking.ensureLive(route.id).catch(() => undefined)
      if (!runner || !auth.canSee(authCtx, runner.info())) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachClient(ctx, ws, runner, req)
      })
    })().catch(() => socket.destroy())
  })

  return {
    server,
    registry,
    queue,
    bridge,
    parking,
    listen: async (port, host) => {
      await profiles.refreshStored()
      await parking.hydrate()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          availability.preflight(profiles.all())
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port })
        })
      })
    },
    drain: async (drainOptions = {}) => {
      const { timeoutMs = 30_000, pollMs = 250, onProgress } = drainOptions
      draining = true
      const deadline = Date.now() + timeoutMs
      let report = surveyDrain(registry)
      onProgress?.(report)
      while (report.working.length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs))
        const next = surveyDrain(registry)
        // Only speak when something actually changed: a shutdown that reports on its own progress should be
        // readable, not a per-tick redraw of the same two lines.
        if (!sameDrain(next, report)) {
          onProgress?.(next)
        }
        report = next
      }
      report = { ...surveyDrain(registry), timedOut: false }
      report.timedOut = report.working.length > 0
      onProgress?.(report)
      return report
    },
    close: () => {
      // Idempotent by contract, not by luck: a second SIGINT re-enters here, and `http.Server.close()` on an
      // already-closed server only fires its callback because we ignore the ERR_SERVER_NOT_RUNNING it passes.
      // Returning the first promise makes the second call a no-op we can reason about.
      closing ??= new Promise((resolve) => {
        queue?.close()
        // Ordering is load-bearing: parking's `#closed` guard must be set before the registry closes runners with
        // reason 'server', or shutdown discards every dormant record. See docs/GOTCHAS.md.
        parking.close()
        registry.closeAll()
        // `wss` is `noServer`, so `wss.close()` neither closes nor terminates clients — it waits for `clients` to
        // empty — and `server.closeAllConnections()` does not reach upgraded sockets. Any attached session socket
        // therefore keeps `server.close()`'s callback from ever firing. Send close frames, then force what lingers.
        for (const ws of wss.clients) {
          ws.close(1001, 'server shutting down')
        }
        queueSockets.clear()
        const force = setTimeout(() => {
          for (const ws of wss.clients) {
            ws.terminate()
          }
        }, SOCKET_CLOSE_GRACE_MS)
        force.unref()
        wss.close()
        server.close(() => {
          clearTimeout(force)
          resolve()
        })
        server.closeAllConnections()
      })
      return closing
    },
  }
}
