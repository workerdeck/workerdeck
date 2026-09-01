import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getEngineAdapter } from '@workerdeck/core'
import type { EngineAdapter } from '@workerdeck/core'
import { JobQueue } from '@workerdeck/queue'
import { PROTOCOL_VERSION, type CreateSessionRequest, type JobEvent, type ProfileEngine, type QueueServerFrame } from '@workerdeck/protocol'
import type { SessionRunnerConfig } from '@workerdeck/core'
import type { ServerContext } from './context.ts'
import { json } from './lib/http.ts'
import { detectDefaultProfiles } from './lib/profile-env.ts'
import { parseSessionRoute } from './lib/parse-route.ts'
import type { LateBoundRefs, WorkerServer, WorkerServerOptions } from './options.ts'
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
    close: () =>
      new Promise((resolve) => {
        queue?.close()
        parking.close()
        registry.closeAll()
        for (const ws of queueSockets) {
          ws.close()
        }
        queueSockets.clear()
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
