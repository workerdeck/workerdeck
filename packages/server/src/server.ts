/**
 * `createWorkerServer` — the assembly. Option types live in `options.ts`, the
 * shared-state record routes take in `context.ts`, per-route behaviour in
 * `routes/`, the stateful pieces in `services/`, and the pure rules in `lib/`.
 * This file only wires them together and dispatches requests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { getEngineAdapter } from '@workerdeck/core'
import type { EngineAdapter } from '@workerdeck/core'
import { JobQueue } from '@workerdeck/queue'
import {
  PROTOCOL_VERSION,
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
import type { WorkerServer, WorkerServerOptions } from './options.ts'
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

// The public option types moved to options.ts; re-exported here so
// `import { ... } from './server.ts'` keeps working for older in-repo callers.
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
    throw new Error(
      'createWorkerServer: provide `authenticate` or explicitly set `allowUnauthenticated: true`',
    )
  }
  const basePath = options.basePath ?? '/v1'
  const fallback = options.fallback
  // Exact origins only — a `Set` because the check runs on every request, and
  // exactness is the whole guarantee (no wildcards, no suffix matching).
  const corsOrigins =
    options.cors?.origins.length ? new Set(options.cors.origins) : undefined
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  /** The engine's adapter, honoring the test-only `engines` override. */
  const adapterFor = (engine: ProfileEngine | undefined): EngineAdapter =>
    options.engines?.[engine ?? 'claude'] ?? getEngineAdapter(engine)

  // ---- Profiles, decorated at response time from the trackers below.
  /**
   * What each claude profile's *default* model resolves to, learned from the
   * `capabilities` events of sessions that ran on it. The model *list* is the
   * adapter's static catalog now; the default is the one thing a catalog
   * cannot know (it is the operator's CLI config), so it alone is still
   * learned — and still absent on a cold server, the accepted regression.
   */
  const profileDefaultModels = new Map<string, string>()
  /** The single plan-usage state per profile, fed from every session's
   * `rate_limit` events and served by `forResponse` (see ProfileUsageTracker). */
  const profileUsage = new ProfileUsageTracker()
  const profiles = new ProfileService({
    // Declared at startup, or a single 'default' auto-created from the
    // operator's own config dir. Misdeclared dirs fail fast — the CLI would
    // otherwise silently start from an empty config (and a different
    // credential chain).
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
    if (invalid) throw new Error(`createWorkerServer: ${invalid}`)
  }

  // ---- The create pipeline. Registry/parking/bridge are late-bound refs,
  // filled just below — construction is mutually recursive (parking's rebuild
  // calls the factory's buildRunner).
  const refs: { registry?: SessionRegistry; parking?: SessionParkManager; bridge?: BridgeHub } = {}
  const factory = createSessionFactory({
    adapterFor,
    profiles,
    hostBuildRunnerConfig:
      options.buildRunnerConfig ?? ((req: CreateSessionRequest): SessionRunnerConfig => req),
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

  // ---- The stateful services.
  // Project identity (`SessionInfo.project`), resolved from `.workerdeck.json`
  // at serve time and never persisted — see ProjectInfoService.
  const projects = new ProjectInfoService()
  // Notifications ride the registry hook rather than the create paths, because the
  // session that most needs to reach a phone may be one that parked and was
  // rebuilt — and that path never goes near `createRunner`.
  const notifier = new SessionNotifier({
    ...options.notifications,
    // A push consumer reads the same decorated record every REST caller does.
    decorateInfo: (info) => projects.withProject(info),
  })
  const producedFiles = new ProducedFileStore()
  const registry = new SessionRegistry({
    onRegister: (runner) => {
      notifier.watch(runner)
      // Same hook, opposite replay choice: from 0, because a rebuilt session's
      // earlier pictures must stay fetchable (see ProducedFileStore.watch).
      producedFiles.watch(runner)
      // Also from 0 — replay is guarded by the events' own timestamps there.
      profileUsage.watch(runner)
      const profile = runner.info().profile
      if (!profile) return
      runner.subscribe((event) => {
        if (event.type !== 'capabilities' || !event.defaultModel) return
        profileDefaultModels.set(profile, event.defaultModel)
      })
    },
  })
  const attachmentStore = new AttachmentStore(options.attachments)
  const bridge = new BridgeHub({
    ...options.bridge,
    onResult: (sessionId, executionId, result) => {
      // A runner that executes out-of-band (the model-agnostic engine bridging
      // to a browser tab) gets the result fed straight back into its loop —
      // operators don't wire this themselves. The host callback still fires,
      // for observability.
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
    // A park restores from its snapshot; a dormant record has none, so it is
    // rebuilt like an ordinary create — the config back through
    // `buildRunnerConfig` (so the profile's env pin and the host hook's
    // injections are re-derived rather than read off disk), `resume` pointed at
    // the engine's own session, and the WorkerDeck id carried over by hand,
    // because nothing in the config would otherwise preserve it.
    rebuild: (record) =>
      isDormant(record)
        ? factory.buildRunner(
            factory.buildRunnerConfig({
              ...record.config,
              // A wake is "come back as you were", never a new turn. `prompt` is
              // the *first* prompt and it was consumed by the original run, but
              // it persists in the record and `start()` sends it unconditionally
              // — so a session created with an opening prompt used to re-run it
              // on top of the thread the resume had just replayed, costing a
              // turn and doing unrequested work. The provider engine has always
              // had this guard for its own rehydration (`if (config.restore)` in
              // `AiSdkRunner.start`); claude and codex resume by `resume`, which
              // — unlike `restore` — is a public request field where
              // `createSession({ resume, prompt })` legitimately means "continue
              // this thread, and here is the next thing". So the suppression
              // belongs here, at the one call site that means rehydration, and
              // not in the runners.
              prompt: undefined,
              // Dropping the prompt would otherwise cost the session its name:
              // `#title()` falls back to deriving one from `prompt` whenever
              // `meta.title` is unset. `record.info.title` has already resolved
              // that precedence, so freezing it into `meta` keeps a derived name
              // through the wake and is a no-op when the session was renamed.
              meta: record.info.title
                ? { ...record.config.meta, title: record.info.title }
                : record.config.meta,
              resume: record.sdkSessionId,
            }),
            undefined,
            record.id,
          )
        : factory.buildRunner(record.config, record.snapshot),
    attachedCount: (sessionId) => bridge.attachedCount(sessionId),
    // Accounting is the queue's: it frees the run's slot and stops its clock, and
    // refuses the park outright when the run is already finalizing.
    onParking: (sessionId, executionId) => queue?.onSessionParking(sessionId, executionId) ?? true,
    onResumed: (sessionId, runner) => queue?.onSessionResumed(sessionId, runner),
  })
  refs.registry = registry
  refs.parking = parking
  refs.bridge = bridge

  const auth = createAuthService({ options, refs })

  const wss = new WebSocketServer({ noServer: true })

  // Live queue watchers (`{basePath}/queue/ws`): every job event is fanned out, and
  // lifecycle changes push refreshed stats so dashboards stay current without polling.
  const queueSockets = new Set<WebSocket>()
  const sendQueueFrame = (ws: WebSocket, frame: QueueServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
  const broadcastJobEvent = (event: JobEvent): void => {
    if (queueSockets.size === 0) return
    for (const ws of queueSockets) sendQueueFrame(ws, { type: 'job_event', event })
    if (event.type !== 'job_progress') {
      void queue
        ?.stats()
        .then((stats) => {
          for (const ws of queueSockets) sendQueueFrame(ws, { type: 'queue_stats', stats })
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
        // Job sessions are ordinary registry sessions (attachable/watchable) and go
        // through the same config hook, engine selection, and auth-provenance
        // watcher as client sessions.
        createRunner: async (config) => {
          const runner = await factory.createRunner(config)
          factory.watchAuthSource(runner)
          return runner
        },
        buildRunnerConfig: factory.buildRunnerConfig,
        // A run that ends while parked (canceled, killed) leaves a snapshot behind
        // that nothing will ever wake.
        discardSession: (sessionId) => parking.discard(sessionId),
      })
    : undefined

  // Host filesystem: built once at startup so a misdeclared root fails here rather
  // than on the first request from a phone. Null = the routes do not exist.
  //
  // Reading inherits the cwd policy — a caller who can start a session in a root
  // can already read it through the agent — so `hostFiles.roots` is a narrowing,
  // not the enabling grant. `??` and not `||`: an explicit `roots: []` is an
  // operator turning the routes off, which must not fall through to the cwd roots.
  const hostFileRootPaths = options.hostFiles?.roots ?? options.allowedCwdRoots
  const hostFiles = hostFileRootPaths?.length ? createHostFileRoots(hostFileRootPaths) : null

  // ---- The record every route module reads.
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

    // CORS, when the host configured it. Resource-sharing policy, not a
    // credential: every route stays behind `authenticate`, and an allowlisted
    // page still has to present the key. `Access-Control-Allow-Credentials` is
    // never sent — that is what keeps the cookie transport same-origin-only, so
    // opening this up cannot turn an ambient cookie into cross-origin authority.
    const origin = req.headers.origin
    const originAllowed =
      typeof origin === 'string' && corsOrigins !== undefined && corsOrigins.has(origin)
    if (originAllowed) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
    }
    // Preflights arrive without credentials (browsers strip them), so they must
    // be answered *before* `authenticate` or every cross-origin call 401s on the
    // OPTIONS. Answering one grants nothing: no body, no side effect.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method'] !== undefined) {
      if (!originAllowed) {
        res.writeHead(403)
        res.end()
        return
      }
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PATCH, PUT, DELETE')
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-workerdeck-key')
      res.setHeader('access-control-max-age', '600')
      // Chrome's Private Network Access: a public page reaching a private
      // address (a tailnet's 100.64/10, a LAN) preflights for this explicitly.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('access-control-allow-private-network', 'true')
      }
      res.writeHead(204)
      res.end()
      return
    }

    // Everything outside basePath belongs to the host, if it wants it. Checked
    // first so the fallback owns a total, contiguous namespace rather than
    // whatever the route table happens to leave over.
    if (fallback && pathname !== basePath && !pathname.startsWith(basePath + '/')) {
      await fallback(req, res)
      return
    }
    if (
      pathname === basePath + '/jobs' ||
      pathname.startsWith(basePath + '/jobs/') ||
      pathname === basePath + '/queue'
    ) {
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
      // The engine's own on-disk store, which is the operator's and spans every
      // scope: there is no per-session id here to filter by.
      if (!auth.isOperator(authCtx)) {
        json(res, 404, { error: 'not found' })
        return
      }
      await handleSdkSessions(ctx, req, res, authCtx)
      return
    }
    if (pathname.startsWith(basePath + '/fs/')) {
      // Authenticated before the 404-when-unconfigured answer, so an unauthenticated
      // caller cannot learn whether this server exposes a filesystem at all.
      const authCtx = await auth.authenticate(req)
      if (!authCtx.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      // Operator privilege by design (see `hostFiles`), so a scoped principal is
      // simply not who these routes are for — and it answers the same 404 an
      // unconfigured gateway does.
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
      if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : 500, { error: message })
      else res.end()
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
        // Every job's events — prompts, progress previews, result text — are
        // fanned to every socket here. There is no per-socket filter yet, so a
        // scoped principal is refused the firehose outright rather than being
        // handed other scopes' runs. (Per-socket filtering is the later fix; a
        // 404 now is the honest version of not having built it.)
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
            .then((stats) =>
              sendQueueFrame(ws, { type: 'queue_attached', protocolVersion: PROTOCOL_VERSION, stats }),
            )
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
      // Scope is checked *before* the wake, off the record's stored info: waking
      // rebuilds the runner and reconnects its MCP servers, and doing that for a
      // caller who is about to get a 404 spends the session's resources on
      // someone with no claim to it.
      const known = registry.get(route.id)?.info() ?? (await parking.get(route.id))?.info
      if (known && !auth.canSee(authCtx, known)) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      // Attaching to a parked session wakes it: the client wants to drive it, and
      // its whole event log comes back with it, so `afterSeq` still lines up.
      const runner = await parking.ensureLive(route.id).catch(() => undefined)
      // Re-checked after the wake as well: the pre-check can only consult what
      // the registry and the store already know, and this is the socket that
      // can drive the session.
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
      // Before the first request: every lookup on the request path reads the
      // in-memory mirror, so it has to be populated before anything can hit it.
      await profiles.refreshStored()
      // Re-index and re-arm anything a durable store carried across a restart.
      await parking.hydrate()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          // After the bind and after refreshStored(), so stored profiles are
          // probed too; advisory, so it must never delay or wedge the listen.
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
        for (const ws of queueSockets) ws.close()
        queueSockets.clear()
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
