import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createFileSessionStore, createWorkerServer, type WorkerServer } from '@workerdeck/server'
import { dashboardDir } from '@workerdeck/web'
import { createApnsForwarder } from '../apns/forwarder.ts'
import { materializeAuthKey, type MaterializedAuthKey } from '../auth/auth-key.ts'
import { createAuthSessionStore } from '../auth/auth-sessions.ts'
import { createCliAuth, type CliAuth } from '../auth/auth.ts'
import { hostnameOf, isLoopbackHostname, type ResolvedConfig } from '../config.ts'
import { renderLoginPage } from '../auth/login-page.ts'
import { createWakeLock, driveWakeLock, sessionsNeedTheMachine } from './keep-awake.ts'
import { looksLikeAsset, resolveWithinRoot, sendHtml, serveFile } from './static.ts'

// The backstop, not the mechanism: the lock is driven by session transitions, and this only has to catch a release
// that no event announced. Long, because holding a laptop awake for one extra minute is the cheap failure.
const WAKE_SWEEP_MS = 60_000

export type Instance = {
  server: WorkerServer
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

function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? '/', 'http://internal').pathname
  } catch {
    return null
  }
}

// The order here is the contract: auth endpoints first (they are how a browser gets a session at all), then the APNs
// route, then assets — ungated, being the app's own code — and documents last, the one place the auth decision is made.
function createFallback(
  auth: CliAuth,
  webRoot: string | undefined,
  hostAllowed: (req: IncomingMessage) => boolean,
  apnsRoute?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
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
    if (apnsRoute !== undefined && (await apnsRoute(req, res))) {
      return
    }
    if (apnsRoute === undefined && pathnameOf(req) === '/apns/devices') {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('this gateway runs without push\n')
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

export async function startInstance(config: ResolvedConfig, options: { quiet?: boolean } = {}): Promise<Instance> {
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
        'materialized — this instance would be open while believing itself authenticated',
    )
  }
  // Sibling of the assert above: CORS on an open gateway lets any allowlisted page drive it with no credential.
  if (config.corsOrigins.length > 0 && !config.hostAuthenticates && !auth.enabled) {
    throw new Error(
      'refusing to serve: corsOrigins is set but this instance has no auth — ' +
        'a cross-origin page could drive it with no credential. Set --auth-key.',
    )
  }
  const hostAllowed = createHostGuard(config.allowedHosts)

  // A bad key path throws before we listen: better a refusal at startup than a phone that never buzzes.
  const apns =
    config.apns === undefined
      ? undefined
      : await createApnsForwarder({
          config: config.apns,
          stateDir: config.stateDir,
          authenticate: (req) => (hostAllowed(req) ? auth.authenticate(req) : null),
        })

  const fallback = createFallback(auth, webRoot, hostAllowed, apns?.handleRequest)

  const parking = { ...config.options.parking }
  if (config.stateDir && !parking.store) {
    parking.store = createFileSessionStore({
      dir: join(config.stateDir, 'parked'),
      onError: (error, context) => {
        process.stderr.write(
          `[workerdeck] parked-session store ${context.op} failed for ${context.path}: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        )
      },
    })
  }

  const server = createWorkerServer({
    ...config.options,
    // On by default here, off in the library: a mispointed config dir should say so at startup.
    checkCredentials: config.options.checkCredentials ?? true,
    parking,
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
    authenticate: config.hostAuthenticates
      ? (req) => (hostAllowed(req) ? config.options.authenticate!(req) : null)
      : (req) => (hostAllowed(req) ? auth.authenticate(req) : null),
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

  const { port } = await server.listen(config.port, config.host)
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`

  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((r) => {
    resolveClosed = r
  })

  if (!options.quiet) {
    const line = (text: string): void => void process.stdout.write(`${text}\n`)
    line('')
    line(`  workerdeck  ${url}`)
    if (config.hostAuthenticates) {
      line('  auth: the config file supplies its own `authenticate`')
    } else if (generated?.source === 'created') {
      line(`  auth: generated key  ${generated.key}`)
      line(`        stored in ${generated.path} — later starts reuse it without printing it`)
    } else if (generated?.source === 'ephemeral') {
      line(`  auth: generated key  ${generated.key}`)
      line('        ephemeral — no state dir to keep it, so the next start mints a new one')
    } else if (generated?.source === 'stored') {
      line(`  auth: shared key from ${generated.path}`)
    } else if (auth.enabled) {
      line('  auth: shared key — browsers sign in, services send a header')
    } else {
      line('  NO AUTH — anyone who can reach this port gets a session')
    }
    if (!config.web) {
      line('  dashboard: off — bare gateway, /v1 and /auth only')
    }
    if (!config.keepAwake) {
      line('  keep-awake: off — this machine may sleep mid-turn')
    }
    if (config.corsOrigins.length) {
      line(`  cors: ${config.corsOrigins.join(', ')} may call /v1 (still key-gated)`)
    }
    line(
      config.stateDir
        ? `  parked sessions persist in ${join(config.stateDir, 'parked')}`
        : '  parked sessions are in memory only — a restart drops them',
    )
    if (apns) {
      const count = apns.deviceCount()
      line(`  push: APNs forwarder on ${config.apns?.topic} — ` + `${count === 0 ? 'no devices registered yet' : `${count} device(s)`}`)
    }
    if (config.configPath) {
      line(`  config ${config.configPath}`)
    }
    line('')
  }

  return {
    server,
    url,
    port,
    closed,
    drain: (drainOptions) => server.drain(drainOptions),
    close: async () => {
      if (sweep) {
        clearInterval(sweep)
      }
      wake?.release()
      await server.close()
      // The session table's writes are queued rather than awaited by the request that caused them, so a last-moment
      // login is lost unless the queue drains here.
      await sessions?.flush?.()
      apns?.close()
      resolveClosed()
    },
  }
}
