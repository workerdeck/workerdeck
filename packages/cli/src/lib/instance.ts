import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import {
  createFileAgentStore,
  createFileProfileStore,
  createFileSessionStore,
  createFileSpendStore,
  createWorkerServer,
  type CarriedSession,
  type WorkerServer,
  type WorkerServerOptions,
} from '@workerdeck/server'
import { dashboardDir } from '@workerdeck/web'
import { createApnsRoute } from '../apns/routes.ts'
import { createApnsForwarder } from '../apns/forwarder.ts'
import { driveLiveActivities } from '../apns/live-activities.ts'
import { materializeAuthKey, type MaterializedAuthKey } from '../auth/auth-key.ts'
import { createAuthSessionStore } from '../auth/auth-sessions.ts'
import { createCliAuth, type CliAuth } from '../auth/auth.ts'
import { hostnameOf, isLoopbackHostname, type ResolvedConfig } from '../config.ts'
import { renderLoginPage } from '../auth/login-page.ts'
import { MonkeyartAvatars } from './avatars.ts'
import { createWakeLock, driveWakeLock, sessionsNeedTheMachine } from './keep-awake.ts'
import { looksLikeAsset, resolveWithinRoot, sendHtml, serveFile } from './static.ts'

// The backstop, not the mechanism: the lock is driven by session transitions, and this only has to catch a release
// that no event announced. Long, because holding a laptop awake for one extra minute is the cheap failure.
const WAKE_SWEEP_MS = 60_000

export type StartOptions = {
  quiet?: boolean
  // Live sessions handed over from a previous generation of this process. See `docs/DEVELOPMENT.md` §Hot reload.
  carried?: CarriedSession[]
}

export type Instance = {
  server: WorkerServer
  // The carried ids this instance took on. Short of the handed-over list when one of them ended while it was held.
  adopted: string[]
  url: string
  port: number
  closed: Promise<void>
  // Let running turns finish before `close()`. See `WorkerServer.drain`.
  drain: WorkerServer['drain']
  close: () => Promise<void>
}

export function resolveWebRoot(): string {
  if (existsSync(join(dashboardDir, 'index.html'))) {
    return dashboardDir
  }
  throw new Error(`no dashboard build at ${dashboardDir}\n` + `  in a checkout: pnpm --filter @workerdeck/web run build`)
}

// Loopback *names* are what is checked, never the socket: a DNS-rebinding attacker's connection really does arrive
// on 127.0.0.1, and the browser's Host header is the one thing they cannot control.
export function createHostGuard(allowedHosts: Set<string> | null): (req: IncomingMessage) => boolean {
  if (allowedHosts === null) {
    return () => true
  }
  return (req) => {
    const header = req.headers.host
    // No Host at all is an HTTP/1.0 client or a script, never a browser being driven cross-origin.
    if (header === undefined) {
      return true
    }
    const hostname = hostnameOf(header)
    if (hostname === '') {
      return false
    }
    return isLoopbackHostname(hostname) || allowedHosts.has(hostname)
  }
}

// Push is server-wide: a registered phone hears about every session, so only an operator may aim one. Mirrors the
// server's own `isOperator`, since a declared session policy withdraws the unscoped-means-operator default.
export function isOperatorPrincipal(principal: unknown, policyDeclared: boolean): boolean {
  if (principal === null || principal === undefined || principal === false) {
    return false
  }
  const { operator, scope } = (typeof principal === 'object' ? principal : {}) as { operator?: unknown; scope?: unknown }
  if (typeof operator === 'boolean') {
    return operator
  }
  const scoped = typeof scope === 'object' && scope !== null && Object.keys(scope).length > 0
  return !scoped && !policyDeclared
}

// The order here is the contract: auth endpoints first (they are how a browser gets a session at all), then the APNs
// route, then assets - ungated, being the app's own code - and documents last, the one place the auth decision is made.
function createFallback(
  auth: CliAuth,
  webRoot: string | undefined,
  hostAllowed: (req: IncomingMessage) => boolean,
  apnsRoute: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(
        'unrecognised Host header.\n\nThis instance runs without auth, so it only answers to ' +
          'loopback host names and the ones it was told to expect. Declare this name with ' +
          '--insecure-host <name> (which also lets it be bound without a key) or --allowed-host ' +
          '<name>, or set --auth-key.\n',
      )
      return
    }
    if (await auth.handleAuthRequest(req, res)) {
      return
    }
    if (await apnsRoute(req, res)) {
      return
    }

    // Below the auth and APNs routes, because turning the *dashboard* off must not turn off the gateway's own surfaces.
    if (webRoot === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('the web dashboard is disabled on this gateway\n')
      return
    }

    const pathname = new URL(req.url ?? '/', 'http://internal').pathname

    if (looksLikeAsset(pathname)) {
      const filePath = resolveWithinRoot(webRoot, pathname)
      if (!filePath) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad request')
        return
      }
      const result = await serveFile(req, res, filePath, {
        immutable: pathname.startsWith('/assets/'),
      })
      if (result === 'served') {
        return
      }
      if (result === 'method-not-allowed') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    if (auth.enabled && !auth.hasValidSession(req)) {
      sendHtml(req, res, 401, renderLoginPage(auth.loginPage(req)), 'no-store')
      return
    }

    const entry = join(webRoot, 'index.html')
    const result = await serveFile(req, res, entry, { immutable: false })
    if (result !== 'served') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dashboard build is missing its entry document')
    }
  }
}

export async function startInstance(config: ResolvedConfig, options: StartOptions = {}): Promise<Instance> {
  const webRoot = config.web ? (config.webRoot ?? resolveWebRoot()) : undefined
  const generated: MaterializedAuthKey | null =
    config.generateAuthKey && !config.hostAuthenticates ? await materializeAuthKey(config.stateDir) : null
  const authOptions = config.hostAuthenticates
    ? { ...config.auth, secret: undefined }
    : generated
      ? { ...config.auth, secret: generated.key }
      : config.auth
  const sessions =
    authOptions.secret !== undefined && config.stateDir ? await createAuthSessionStore({ stateDir: config.stateDir }) : undefined
  const auth = createCliAuth(sessions ? { ...authOptions, sessions } : authOptions)
  // Keep this assert: it is the only thing between "the config stood the Host-header guard down expecting auth" and
  // "createCliAuth got no secret", which is an instance wide open while reporting itself authenticated.
  if (config.allowedHosts === null && !config.hostAuthenticates && !auth.enabled) {
    throw new Error(
      'refusing to serve: the resolved config expects auth but no shared secret was ' +
        'materialized - this instance would be open while believing itself authenticated',
    )
  }
  // Sibling of the assert above: CORS on an open gateway lets any allowlisted page drive it with no credential.
  if (config.corsOrigins.length > 0 && !config.hostAuthenticates && !auth.enabled) {
    throw new Error(
      'refusing to serve: corsOrigins is set but this instance has no auth - ' +
        'a cross-origin page could drive it with no credential. Set --auth-key.',
    )
  }
  const hostAllowed = createHostGuard(config.allowedHosts)

  // The same hook `/v1` runs, so a config file's own `authenticate` guards push too rather than the (then open) built-in.
  const authenticateRequest = config.hostAuthenticates ? config.options.authenticate! : auth.authenticate
  const policyDeclared = config.options.authorizeSession !== undefined
  const authenticatePush = async (req: IncomingMessage): Promise<unknown> => {
    if (!hostAllowed(req)) {
      return null
    }
    const principal = await authenticateRequest(req)
    return isOperatorPrincipal(principal, policyDeclared) ? principal : null
  }
  // A bad key path throws before we listen: better a refusal at startup than a phone that never buzzes.
  const apns =
    config.apns === undefined
      ? undefined
      : await createApnsForwarder({
          config: config.apns,
          stateDir: config.stateDir,
          authenticate: authenticatePush,
        })

  const fallback = createFallback(auth, webRoot, hostAllowed, apns?.handleRequest ?? createApnsRoute(null, authenticatePush))

  const { parking, profileStore, shell, spend } = stateDirDefaults(config)

  const server = createWorkerServer({
    ...config.options,
    ...(profileStore ? { profileStore } : {}),
    // On by default here, off in the library: a mispointed config dir should say so at startup.
    checkCredentials: config.options.checkCredentials ?? true,
    parking,
    shell,
    spend,
    avatars: config.options.avatars ?? new MonkeyartAvatars(),
    // Composed, not replaced: turning push on must not unhook a config file's own observer.
    notifications:
      apns === undefined
        ? config.options.notifications
        : {
            ...config.options.notifications,
            onNotification: (notification) => {
              config.options.notifications?.onNotification?.(notification)
              apns.onNotification(notification)
            },
          },
    fallback,
    ...(config.corsOrigins.length ? { cors: { origins: config.corsOrigins } } : {}),
    // A config file's own `authenticate` wins outright: mixing two auth schemes on one hook is a bypass nobody meant to
    // write. The unauthenticated case still supplies one rather than `allowUnauthenticated`, so the Host check covers `/v1`.
    authenticate: (req) => (hostAllowed(req) ? authenticateRequest(req) : null),
  })

  const wake = config.keepAwake
    ? createWakeLock({
        onUnavailable: (reason) => {
          if (!options.quiet) {
            process.stderr.write(`[workerdeck] not holding the machine awake: ${reason}\n`)
          }
        },
      })
    : undefined
  let sweep: ReturnType<typeof setInterval> | undefined
  if (wake) {
    driveWakeLock(server.registry, wake)
    sweep = setInterval(() => wake.set(sessionsNeedTheMachine(server.registry.list())), WAKE_SWEEP_MS)
    sweep.unref()
  }

  let stopActivities: (() => void) | undefined
  if (apns) {
    // Boot reconcile before the driver, and before any session rebuilds: whatever is in the
    // activities file belongs to a process that is gone, so its cards are lying about a turn that
    // died with it. A `kill -9` skips this, which is what `stale-date` is for.
    await apns.activity.endAll('Gateway restarted')
    stopActivities = driveLiveActivities({ source: server.registry, target: apns.activity })
  }

  // Before `listen`, never after: between the port opening and the adoption, an attach for a carried id reads its
  // dormant record and resumes a SECOND engine child on the same transcript. Registering first closes the window
  // outright rather than masking it, and `listInfo` then hides the record for free.
  const adopted: CarriedSession[] = []
  for (const carried of options.carried ?? []) {
    if (server.adoptSession(carried)) {
      adopted.push(carried)
    }
  }

  let port: number
  try {
    ;({ port } = await server.listen(config.port, config.host))
  } catch (error) {
    // Release before close: `close()` closes every runner the registry holds, which for a carried session is the
    // engine child this whole path exists to keep. Release first and the registry is empty, so it closes nothing.
    for (const carried of adopted) {
      server.releaseSession(carried.runner.id)
    }
    await server.close()
    throw error
  }
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`

  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((r) => {
    resolveClosed = r
  })

  if (!options.quiet) {
    const push = apns && { topic: config.apns?.topic, devices: apns.deviceCount(), cards: apns.activity.count() }
    process.stdout.write(bannerLines({ url, config, generated, authEnabled: auth.enabled, push }).join('\n') + '\n')
  }

  return {
    server,
    adopted: adopted.map((carried) => carried.runner.id),
    url,
    port,
    closed,
    drain: (drainOptions) => server.drain(drainOptions),
    close: async () => {
      if (sweep) {
        clearInterval(sweep)
      }
      wake?.release()
      stopActivities?.()
      await server.close()
      // The session table's writes are queued rather than awaited by the request that caused them, so a last-moment
      // login is lost unless the queue drains here.
      await sessions?.flush?.()
      if (apns) {
        // A card outlives the gateway that drew it, so a clean shutdown is the one chance to say so.
        // Capped, because a phone that cannot be reached must not hold the process open.
        await Promise.race([apns.activity.endAll('Gateway stopped'), new Promise((resolve) => setTimeout(resolve, 3_000))])
      }
      apns?.close()
      resolveClosed()
    },
  }
}

type StateDirDefaults = Pick<WorkerServerOptions, 'agentStore' | 'parking' | 'profileStore' | 'shell' | 'spend'>

// Everything the state dir backs by default. A config file's own store wins; with no state dir everything stays in memory,
// and profile management stays refused rather than silently forgetting every profile on restart.
export function stateDirDefaults(config: ResolvedConfig): StateDirDefaults {
  const { stateDir } = config
  const parking = { ...config.options.parking }
  const shell = { ...config.options.shell }
  const spend = { ...config.options.spend }
  if (!stateDir) {
    return { parking, shell, spend }
  }
  parking.store ??= createFileSessionStore({
    dir: join(stateDir, 'parked'),
    onError: (error, context) => {
      process.stderr.write(
        `[workerdeck] parked-session store ${context.op} failed for ${context.path}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      )
    },
  })
  if (shell.artifactDir === undefined) {
    shell.artifactDir = join(stateDir, 'shells')
  }
  spend.store ??= createFileSpendStore(join(stateDir, 'spend.json'), (error) => {
    process.stderr.write(`[workerdeck] spend ledger write failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  const profileStore = config.profileStore ? createFileProfileStore(join(stateDir, 'profiles.json')) : undefined
  const agentStore = config.options.agentStore ?? createFileAgentStore(join(stateDir, 'agents.json'))
  return { parking, shell, spend, agentStore, ...(profileStore ? { profileStore } : {}) }
}

export type BannerInput = {
  url: string
  config: ResolvedConfig
  generated: MaterializedAuthKey | null
  authEnabled: boolean
  push: { topic: string | undefined; devices: number; cards: number } | undefined
}

export function bannerLines({ url, config, generated, authEnabled, push }: BannerInput): string[] {
  const lines = ['', `  workerdeck  ${url}`]
  if (config.hostAuthenticates) {
    lines.push('  auth: the config file supplies its own `authenticate`')
  } else if (generated?.source === 'created') {
    lines.push(`  auth: generated key  ${generated.key}`, `        stored in ${generated.path} - later starts reuse it without printing it`)
  } else if (generated?.source === 'ephemeral') {
    lines.push(`  auth: generated key  ${generated.key}`, '        ephemeral - no state dir to keep it, so the next start mints a new one')
  } else if (generated?.source === 'stored') {
    lines.push(`  auth: shared key from ${generated.path}`)
  } else if (authEnabled) {
    lines.push('  auth: shared key - browsers sign in, services send a header')
  } else {
    lines.push('  NO AUTH - anyone who can reach this port gets a session')
  }
  if (!config.web) {
    lines.push('  dashboard: off - bare gateway, /v1 and /auth only')
  }
  if (!config.keepAwake) {
    lines.push('  keep-awake: off - this machine may sleep mid-turn')
  }
  if (config.corsOrigins.length) {
    lines.push(`  cors: ${config.corsOrigins.join(', ')} may call /v1 (still key-gated)`)
  }
  lines.push(
    config.stateDir
      ? `  parked sessions persist in ${join(config.stateDir, 'parked')}`
      : '  parked sessions are in memory only - a restart drops them',
  )
  if (push) {
    lines.push(
      `  push: APNs forwarder on ${push.topic} - ` +
        `${push.devices === 0 ? 'no devices registered yet' : `${push.devices} device(s)`}` +
        `${push.cards === 0 ? '' : `, ${push.cards} live card(s)`}`,
    )
  }
  if (config.configPath) {
    lines.push(`  config ${config.configPath}`)
  }
  lines.push('')
  return lines
}
