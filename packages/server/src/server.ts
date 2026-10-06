import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import {
  contextResetDirectoryHandle,
  getEngineAdapter,
  installContextResetDirectory,
  installPeerDirectory,
  installShellDirectory,
  peerDirectoryHandle,
  shellDirectoryHandle,
} from '@workerdeck/core'
import type { EngineAdapter, PeerDirectory, Runner, SessionRunnerConfig } from '@workerdeck/core'
import { JobQueue } from '@workerdeck/queue'
import { mergePricing, type CreateSessionRequest, type ProfileEngine } from '@workerdeck/protocol'
import type { ServerContext } from './context.ts'
import { createServerLifecycle } from './lifecycle.ts'
import { httpErrorStatus, json } from './lib/http.ts'
import { detectDefaultProfiles } from './lib/profile-env.ts'
import { reloadPlan } from './lib/reload-plan.ts'
import type { DiagnosticSink, WorkerServer, WorkerServerOptions } from './options.ts'
import { createQueueSocketHub } from './routes/queue-ws.ts'
import { upgradeSession } from './routes/session-upgrade.ts'
import { dispatchRoute, httpRoutes } from './routes/table.ts'
import { createMemoryAgentStore } from './services/agent-store.ts'
import { AgentService } from './services/agents.ts'
import { AttachmentStore } from './services/attachments.ts'
import { createAuthService } from './services/auth.ts'
import { AvailabilityTracker } from './services/availability.ts'
import { EngineSleepTimers } from './services/engine-sleep.ts'
import { ContextResetService } from './services/context-resets.ts'
import { BridgeHub } from './services/bridge.ts'
import { createHostFileRoots } from './services/host-files.ts'
import { SessionNotifier } from './services/notifications.ts'
import { SessionParkManager } from './services/parking.ts'
import { ProducedFileStore } from './services/produced-files.ts'
import { ProfileService, isEffortMap } from './services/profiles.ts'
import { ProfileUsageTracker } from './services/profile-usage.ts'
import { SpendLedger } from './services/spend-ledger.ts'
import { createRelayLink } from './services/peer-relay.ts'
import { createPeerService } from './services/peers.ts'
import { ProjectInfoService } from './services/project-info.ts'
import { SessionRegistry } from './services/registry.ts'
import { createSessionFactory, type SessionFactory } from './services/session-factory.ts'
import { createShellDirectory, createShellRegistry, type ShellRegistry } from './services/shells.ts'
import { isDormant, MemorySessionStore, type StoredSessionRecord } from './services/session-store.ts'

export type {
  Authenticator,
  EngineRunnerContext,
  QueueServerOptions,
  SdkSessionLister,
  WorkerServer,
  WorkerServerOptions,
} from './options.ts'

// How old the account-level rate-limit reading may be before a profiles read asks a live session for a newer one.
// Generous: the windows move over hours, and the point is to bound staleness at minutes rather than at days.
const USAGE_STALE_MS = 5 * 60_000

// Every client frame is a command or a bridged result; images travel over the attachments route, never the socket.
const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024

export function createWorkerServer(options: WorkerServerOptions = {}): WorkerServer {
  if (!options.authenticate && !options.allowUnauthenticated) {
    throw new Error('createWorkerServer: provide `authenticate` or explicitly set `allowUnauthenticated: true`')
  }
  const basePath = options.basePath ?? '/v1'
  const fallback = options.fallback
  const corsOrigins = options.cors?.origins.length ? new Set(options.cors.origins) : undefined
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const diagnose: DiagnosticSink = options.onDiagnostic ?? (() => {})
  const adapterFor = (engine: ProfileEngine | undefined): EngineAdapter => options.engines?.[engine ?? 'claude'] ?? getEngineAdapter(engine)

  const pricing = mergePricing(options.pricing?.overrides)
  if (pricing.dropped.length > 0) {
    console.warn(
      `[workerdeck] Ignoring pricing.overrides for ${pricing.dropped.join(', ')}: ` +
        'each entry needs input, output, cacheWrite5m, cacheWrite1h and cacheRead in USD per million tokens',
    )
  }

  const profileDefaultModels = new Map<string, string>()
  const profileUsage = new ProfileUsageTracker()
  const spendLedger = new SpendLedger({
    pricing: pricing.pricing,
    store: options.spend?.store,
    monthlySubscriptionUsd: (name) => options.spend?.monthlySubscriptionUsd?.[name] ?? options.spend?.monthlySubscriptionUsd?.['*'],
    onError: (error) => options.spend?.onError?.(error),
  })
  void spendLedger.load()
  // With a store in play, detection seeds it on first launch instead of declaring anything: a
  // declared profile cannot be edited over the API, and an auto-detected one is exactly the profile
  // an operator most wants to rename or retarget.
  const detected = options.profiles ? [] : detectDefaultProfiles()
  const profiles = new ProfileService({
    declared: options.profiles ?? (options.profileStore ? [] : detected),
    seed: detected,
    store: options.profileStore,
    allowedConfigDirRoots: options.allowedConfigDirRoots,
    disableBypassPermissions: options.disableBypassPermissions,
    hasEngineRunnerFactory: options.createEngineRunner !== undefined,
    adapterFor,
    decorate: {
      defaultModel: (name) => profileDefaultModels.get(name),
      availability: (name) => availability.get(name),
      usage: (name) => {
        refreshStaleUsage(registry, profileUsage, name, diagnose)
        return profileUsage.usage(name)
      },
      spend: (name) => spendLedger.spend(name),
    },
  })
  for (const p of options.profiles ?? []) {
    const invalid = profiles.validate(p)
    if (invalid) {
      throw new Error(`createWorkerServer: ${invalid}`)
    }
  }

  const generation = randomUUID()
  const shells = options.shell?.enabled === true ? shellRegistryFor(options.shell, generation) : null
  const agents = new AgentService({
    store: options.agentStore ?? createMemoryAgentStore(),
    basePath,
    avatars: options.avatars !== undefined,
    sleepAfterMs: options.agentSleepAfterMs,
  })
  const projects = new ProjectInfoService({ decorate: (info) => agents.decorate(shells ? shells.decorate(info) : info) })

  const notifier = new SessionNotifier({
    ...options.notifications,
    decorateInfo: (info) => projects.withProject(info),
    onError: options.notifications?.onError ?? ((error, context) => diagnose(error, `notification-${context.op}`)),
  })
  const producedFiles = new ProducedFileStore()
  const engineSleep = new EngineSleepTimers({
    afterMs: options.engineSleepAfterMs ?? 0,
    afterMsFor: (sessionId) => agents.sleepAfterFor(sessionId),
    attachedCount: (sessionId) => bridge.attachedCount(sessionId),
    onError: (error) => diagnose(error, 'engine-sleep'),
  })
  const contextResets =
    options.agentContextReset === false
      ? undefined
      : new ContextResetService({ ...options.agentContextReset, onError: (error) => diagnose(error, 'context-reset') })
  let ownContextResets = contextResets
  installContextResetDirectory(contextResets)
  // Built first because everything else holds it. The watchers it attaches read the later-built services only when
  // a runner registers, which no code path does before this function returns.
  const registry = new SessionRegistry({
    // Every watcher here hands back its detach, and the registry runs them when the runner leaves. A hot reload is
    // the case that needs it: the runner outlives this server, and these closures would otherwise keep delivering
    // webhooks and pushes from a generation that is over, one extra copy per reload.
    onRegister: (runner) => {
      const detachers = [
        notifier.watch(runner),
        producedFiles.watch(runner),
        profileUsage.watch(runner),
        spendLedger.watch(runner),
        shells?.watch(runner),
        peers?.watch(runner),
        factory.watchAuthSource(runner),
        engineSleep.watch(runner),
        contextResets?.watch(runner),
      ]
      const profile = runner.info().profile
      if (profile) {
        detachers.push(
          runner.subscribe((event) => {
            if (event.type !== 'capabilities' || !event.defaultModel) {
              return
            }
            profileDefaultModels.set(profile, event.defaultModel)
          }),
        )
      }
      return () => {
        for (const detach of detachers) {
          detach?.()
        }
      }
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
    rebuild: (record) => rebuildRunner(factory, record),
    attachedCount: (sessionId) => bridge.attachedCount(sessionId),
    onParking: (sessionId) => queue?.canParkSession(sessionId) ?? true,
    onParked: (sessionId, executionId) => void queue?.onSessionParking(sessionId, executionId),
    onResumed: (sessionId, runner) => queue?.onSessionResumed(sessionId, runner),
  })

  const peers =
    options.peers?.enabled === false ? undefined : createPeerService({ refs: { registry, parking }, projects, options: options.peers })
  const shellDirectory = shells ? createShellDirectory(shells, { runnerFor: (id) => registry.get(id) }) : undefined
  // Each runner resolves its own server's directory first and the process-wide slot only once that server has
  // closed, which is the hot-reload handover: a carried runner then reaches whichever generation installed last.
  const relay =
    peers && options.relay
      ? createRelayLink(options.relay, peers, options.relay.log ?? ((message) => diagnose(new Error(message), 'relay')))
      : undefined
  let ownPeers: PeerDirectory | undefined = relay?.directory ?? peers
  let ownShells = shellDirectory
  if (ownPeers) {
    installPeerDirectory(ownPeers)
  }
  installShellDirectory(shellDirectory)
  if (options.effortDefaults !== undefined && !isEffortMap(options.effortDefaults)) {
    throw new Error('createWorkerServer: `effortDefaults` must map model names to effort levels')
  }
  const factory = createSessionFactory({
    adapterFor,
    profiles,
    hostBuildRunnerConfig: options.buildRunnerConfig ?? ((req: CreateSessionRequest): SessionRunnerConfig => req),
    createEngineRunner: options.createEngineRunner,
    allowedCwdRoots: options.allowedCwdRoots,
    disableBypassPermissions: options.disableBypassPermissions,
    approvalTimeoutMs: options.approvalTimeoutMs,
    effortDefaults: options.effortDefaults,
    requireApiKey: options.requireApiKey,
    peers: peers ? peerDirectoryHandle(() => ownPeers) : undefined,
    contextReset: contextResets
      ? { directory: contextResetDirectoryHandle(() => ownContextResets), defaultEnabled: contextResets.defaultEnabled }
      : undefined,
    shells: shellDirectory ? shellDirectoryHandle(() => ownShells) : undefined,
    shellAgentWrite: options.shell?.agentWrite,
    pricing: pricing.pricing,
    registry,
    parking,
    bridge,
    agentBrief: (sessionId) => agents.briefFor(sessionId),
  })

  const availability = new AvailabilityTracker({
    checkCredentials: options.checkCredentials,
    requireAvailableProfile: options.requireAvailableProfile,
    adapterFor,
    sessionEnvFor: factory.sessionEnvFor,
    onError: (error) => diagnose(error, 'availability-probe'),
  })

  const auth = createAuthService({ options, registry })

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES })
  const queueSockets = createQueueSocketHub({ wss, auth, queue: () => queue, diagnose })

  const queue = options.queue
    ? new JobQueue({
        ...options.queue,
        onEvent: (event) => {
          try {
            options.queue?.onEvent?.(event)
          } finally {
            queueSockets.broadcast(event)
          }
        },
        createRunner: (config) => factory.createRunner(config),
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
    agents,
    avatars: options.avatars,
    registry,
    parking,
    engineSleep,
    peers: peers ? peerDirectoryHandle(() => ownPeers) : undefined,
    bridge,
    projects,
    queue,
    attachmentStore,
    producedFiles,
    hostFiles,
    hostFilesWritable: options.hostFiles?.write === true,
    maxHostFileBytes: options.hostFiles?.maxFileBytes ?? 1024 * 1024,
    maxHostDirEntries: options.hostFiles?.maxEntries ?? 5000,
    shells,
    generation,
    pricingOverrides: Object.keys(pricing.overrides).length > 0 ? pricing.overrides : undefined,
  }
  const routes = httpRoutes(ctx)

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (answerCors(req, res, corsOrigins)) {
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname
    if (fallback && pathname !== basePath && !pathname.startsWith(basePath + '/')) {
      await fallback(req, res)
      return
    }
    await dispatchRoute(ctx, routes, req, res, lifecycle.draining())
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error'
      if (!res.headersSent) {
        json(res, httpErrorStatus(error), { error: message })
      } else {
        res.end()
      }
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://internal').pathname
      if (pathname === basePath + '/queue/ws') {
        await queueSockets.upgrade(req, socket, head)
        return
      }
      await upgradeSession(ctx, wss, req, socket, head)
    })().catch(() => socket.destroy())
  })

  const lifecycle = createServerLifecycle({
    server,
    wss,
    registry,
    parking,
    shells,
    queue,
    engineSleep,
    closeQueueSockets: queueSockets.clear,
    diagnose,
    releaseDirectories: () => {
      relay?.close()
      ownPeers = undefined
      ownShells = undefined
      contextResets?.close()
      ownContextResets = undefined
    },
  })

  return {
    server,
    registry,
    queue,
    bridge,
    parking,
    shells,
    listen: async (port, host) => {
      await profiles.refreshStored()
      await profiles.seedStore()
      await agents.hydrate()
      await parking.hydrate()
      await shells?.hydrate()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          availability.preflight(profiles.all())
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port })
        })
      })
    },
    releaseSession: (id) => {
      const runner = registry.get(id)
      if (!runner) {
        return undefined
      }
      const plan = reloadPlan(runner)
      if (plan !== 'carry') {
        throw new Error(`session ${id} cannot be carried by identity (${plan})`)
      }
      const config = parking.release(id)
      registry.evict(id)
      return { runner, config }
    },
    adoptSession: ({ runner, config }) => {
      // Re-checked here, not only at release: a runner held across a failed generation may have ended in the
      // meantime, and adopting a dead one would list a session nothing can answer.
      if (reloadPlan(runner) !== 'carry') {
        return false
      }
      parking.adopt(runner, config)
      return true
    },
    releaseRelay: () => relay?.release(),
    drain: lifecycle.drain,
    close: lifecycle.close,
  }
}

// The backstop behind the attach-time refresh, for the surface that reads the account number without opening a
// session at all. Fire and forget: this request still answers with what is known, and the newer reading arrives
// as a `rate_limit` event moments later. One session per profile is enough - the reading is account-level - and
// the runner's own throttle is what keeps a page of profiles from becoming a page of control requests.
function refreshStaleUsage(registry: SessionRegistry, profileUsage: ProfileUsageTracker, name: string, diagnose: DiagnosticSink): void {
  const held = profileUsage.usage(name)
  const newest = Math.max(0, ...Object.values(held ?? {}).map((window) => window.updatedAt ?? 0))
  if (Date.now() - newest < USAGE_STALE_MS) {
    return
  }
  for (const info of registry.list()) {
    if (info.profile !== name) {
      continue
    }
    const runner = registry.get(info.id)
    if (runner?.refreshUsage) {
      void runner.refreshUsage().catch((error: unknown) => diagnose(error, 'usage-refresh'))
      return
    }
  }
}

function answerCors(req: IncomingMessage, res: ServerResponse, corsOrigins: Set<string> | undefined): boolean {
  const origin = req.headers.origin
  const originAllowed = typeof origin === 'string' && corsOrigins !== undefined && corsOrigins.has(origin)
  if (originAllowed) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
  }
  if (req.method !== 'OPTIONS' || req.headers['access-control-request-method'] === undefined) {
    return false
  }
  if (!originAllowed) {
    res.writeHead(403)
    res.end()
    return true
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
  return true
}

function shellRegistryFor(shell: NonNullable<WorkerServerOptions['shell']>, generation: string): ShellRegistry {
  return createShellRegistry({
    generation,
    artifactDir: shell.artifactDir ?? null,
    timeoutMs: shell.timeoutMs,
    artifactMaxBytes: shell.artifactMaxBytes,
    artifactTtlMs: shell.artifactTtlMs,
    maxRunningPerSession: shell.maxRunningPerSession,
    onError: (error, context) =>
      console.warn(`[workerdeck] shell ${context.op} error (${context.shellId ?? context.sessionId ?? '-'}): ${String(error)}`),
  })
}

// A dormant record holds only the config and the SDK id to resume from, so it goes back through the host's hook; a
// parked one carries its own snapshot.
function rebuildRunner(factory: SessionFactory, record: StoredSessionRecord): Promise<Runner> {
  if (!isDormant(record)) {
    return factory.buildRunner(record.config, record.snapshot)
  }
  return factory.buildRunner(
    {
      ...factory.buildRunnerConfig({
        ...record.config,
        prompt: undefined,
        resume: record.sdkSessionId,
      }),
      // Applied after the host's hook, which is free to rebuild the config from the
      // request and would drop a field it has never heard of.
      epoch: (record.info.epoch ?? 0) + 1,
      fallbackTitle: record.info.title,
      startAsleep: true,
    },
    undefined,
    record.id,
  )
}
