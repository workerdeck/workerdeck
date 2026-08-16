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
import { looksLikeAsset, resolveWithinRoot, sendHtml, serveFile } from './static.ts'

export type Instance = {
  server: WorkerServer
  url: string
  port: number
  /** Resolves when the instance stops serving. */
  closed: Promise<void>
  close: () => Promise<void>
}

/**
 * The dashboard comes from `@workerdeck/web`, which ships it prebuilt and
 * exports the path to it. Depending on the package rather than vendoring a copy
 * means one dashboard, versioned in lockstep with everything else.
 *
 * In a checkout that directory only exists once the app has been built — dev
 * never builds — so the miss is worth a real message rather than a stack trace
 * from the static host.
 */
export function resolveWebRoot(): string {
  if (existsSync(join(dashboardDir, 'index.html'))) return dashboardDir
  throw new Error(
    `no dashboard build at ${dashboardDir}\n` +
      `  in a checkout: pnpm --filter @workerdeck/web run build`,
  )
}

/**
 * The Host-header gate for an unauthenticated instance. `allowedHosts` is null
 * whenever auth is on, and then this is the identity function — with a
 * credential in play a rebound origin holds no cookie and fails `authenticate`
 * anyway. Loopback *names* are what's checked, not the socket: the attacker in
 * this scenario controls DNS, so the connection genuinely arrives on 127.0.0.1;
 * what they cannot control is the name the victim's browser writes into Host.
 */
export function createHostGuard(allowedHosts: Set<string> | null): (req: IncomingMessage) => boolean {
  if (allowedHosts === null) return () => true
  return (req) => {
    const header = req.headers.host
    // No Host at all is an HTTP/1.0 client or a raw script, never a browser
    // being driven cross-origin — and it cannot be a rebinding victim.
    if (header === undefined) return true
    const hostname = hostnameOf(header)
    if (hostname === '') return false
    return isLoopbackHostname(hostname) || allowedHosts.has(hostname)
  }
}

/**
 * Everything outside `/v1`. Order matters: the auth endpoints first (they are
 * how a browser gets a session in the first place), then assets, which stay
 * ungated — they are the app's own code, hold no secrets, and gating them would
 * only mean the login page could not be styled by the app it gates. Documents
 * come last, and that is the single place the auth decision is made.
 *
 * The APNs device route sits between auth and assets: it does its own
 * authentication (header only — it is never called by a browser), and it must
 * not fall through to the SPA's catch-all, which would answer a failed
 * registration with a 200 and an HTML document.
 */
function createFallback(
  auth: CliAuth,
  /** Undefined when the dashboard is switched off — everything below the auth
   * and APNs routes then 404s, and `/v1` is unaffected. */
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
    if (await auth.handleAuthRequest(req, res)) return
    if (apnsRoute !== undefined && (await apnsRoute(req, res))) return

    // Nothing below this point exists without a dashboard. Deliberately after
    // the auth and APNs routes: turning the *dashboard* off must not turn off
    // the gateway's own surfaces, and `/v1` never reaches this hook at all.
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
      // Hashed filenames are immutable by construction; index.html never is, and
      // it is served below as a document, not here.
      const result = await serveFile(req, res, filePath, {
        immutable: pathname.startsWith('/assets/'),
      })
      if (result === 'served') return
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

    // The SPA uses hash history, so every route is `#/…` and the server only
    // ever serves the entry document — no rewrite rules, and a deep link works
    // on a static host. `no-cache` on it is what lets an update actually land.
    const entry = join(webRoot, 'index.html')
    const result = await serveFile(req, res, entry, { immutable: false })
    if (result !== 'served') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dashboard build is missing its entry document')
    }
  }
}

export async function startInstance(
  config: ResolvedConfig,
  options: { quiet?: boolean } = {},
): Promise<Instance> {
  // Resolved lazily: `resolveWebRoot` throws when there is no build, and an
  // instance told not to serve the dashboard should not need one to exist.
  const webRoot = config.web ? (config.webRoot ?? resolveWebRoot()) : undefined
  // The other half of `generateAuthKey`: resolution promised auth without doing
  // I/O, this is where the key actually comes to exist.
  const generated: MaterializedAuthKey | null =
    config.generateAuthKey && !config.hostAuthenticates
      ? await materializeAuthKey(config.stateDir)
      : null
  const authOptions = config.hostAuthenticates
    ? { ...config.auth, secret: undefined }
    : generated
      ? { ...config.auth, secret: generated.key }
      : config.auth
  // Browser logins persist beside the key they were granted against, for the
  // same reason the key does: a restart should not un-pair every client. Only
  // meaningful when there is a secret to log in with and somewhere to write.
  const sessions =
    authOptions.secret !== undefined && config.stateDir
      ? await createAuthSessionStore({ stateDir: config.stateDir })
      : undefined
  const auth = createCliAuth(sessions ? { ...authOptions, sessions } : authOptions)
  // The failure mode this seam must make impossible: a resolved config that
  // stood down the Host-header guard (allowedHosts null) believing auth would
  // be on, while `createCliAuth` ended up with no secret — that instance would
  // be wide open and reporting itself authenticated. Every start passes through
  // here, so a bug on either side of the seam dies loudly instead of serving.
  if (config.allowedHosts === null && !config.hostAuthenticates && !auth.enabled) {
    throw new Error(
      'refusing to serve: the resolved config expects auth but no shared secret was ' +
        'materialized — this instance would be open while believing itself authenticated',
    )
  }
  // Sibling of the assert above, guarding the same promise from the other side.
  // CORS on an open gateway would let any allowlisted page read and drive it
  // with no credential at all — the sanctioned answer to "I want a remote
  // dashboard on a keyless gateway" is to set a key.
  if (config.corsOrigins.length > 0 && !config.hostAuthenticates && !auth.enabled) {
    throw new Error(
      'refusing to serve: corsOrigins is set but this instance has no auth — ' +
        'a cross-origin page could drive it with no credential. Set --auth-key.',
    )
  }
  const hostAllowed = createHostGuard(config.allowedHosts)

  // The only push credential in the project, and it is here rather than in
  // `packages/server` by design: the OSS gateway emits notifications and holds
  // nothing that could deliver one. A bad key path throws before we listen —
  // better a refusal at launch than a phone that never buzzes and never says why.
  const apns =
    config.apns === undefined
      ? undefined
      : await createApnsForwarder({
          config: config.apns,
          stateDir: config.stateDir,
          // The same principal check as everything else on this origin, so the
          // app registers with the key it already holds.
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
    // The turnkey instance checks profile credentials at startup by default —
    // a mispointed config dir should say so here, not as the first session's
    // "Not logged in" error. A config file can set `checkCredentials: false`.
    checkCredentials: config.options.checkCredentials ?? true,
    parking,
    // Composed, not replaced: a config file may already have a webhook and its
    // own observer, and turning push on must not silently unhook either.
    notifications: apns === undefined ? config.options.notifications : {
      ...config.options.notifications,
      onNotification: (notification) => {
        config.options.notifications?.onNotification?.(notification)
        apns.onNotification(notification)
      },
    },
    fallback,
    ...(config.corsOrigins.length ? { cors: { origins: config.corsOrigins } } : {}),
    // A config file's own `authenticate` wins outright — mixing two auth schemes
    // on one hook is how you end up with a bypass nobody meant to write. The
    // host guard still wraps it, but it is a no-op whenever auth is on.
    //
    // Note the unauthenticated case supplies an `authenticate` too rather than
    // `allowUnauthenticated`: the Host check has to cover `/v1`, which is the
    // half of the surface a rebinding attack actually wants.
    authenticate: config.hostAuthenticates
      ? (req) => (hostAllowed(req) ? config.options.authenticate!(req) : null)
      : (req) => (hostAllowed(req) ? auth.authenticate(req) : null),
  })

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
    if (config.hostAuthenticates) line('  auth: the config file supplies its own `authenticate`')
    else if (generated?.source === 'created') {
      // Printed exactly once, at creation — later starts reuse the file and
      // point at it instead of spraying the secret into every log.
      line(`  auth: generated key  ${generated.key}`)
      line(`        stored in ${generated.path} — later starts reuse it without printing it`)
    } else if (generated?.source === 'ephemeral') {
      line(`  auth: generated key  ${generated.key}`)
      line('        ephemeral — no state dir to keep it, so the next start mints a new one')
    } else if (generated?.source === 'stored') {
      line(`  auth: shared key from ${generated.path}`)
    } else if (auth.enabled) line('  auth: shared key — browsers sign in, services send a header')
    else line('  NO AUTH — anyone who can reach this port gets a session')
    // Said plainly, because the URL above is the first thing an operator will
    // paste into a browser and it now answers 404.
    if (!config.web) line('  dashboard: off — bare gateway, /v1 and /auth only')
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
      line(
        `  push: APNs forwarder on ${config.apns?.topic} — ` +
          `${count === 0 ? 'no devices registered yet' : `${count} device(s)`}`,
      )
    }
    if (config.configPath) line(`  config ${config.configPath}`)
    line('')
  }

  return {
    server,
    url,
    port,
    closed,
    close: async () => {
      await server.close()
      // The session table's writes are queued, not awaited by the request that
      // caused them — a login should not wait on a disk write. So shutdown is
      // where the queue has to be drained: without this, a login or logout in
      // the last moments of a process is simply lost, and `close()` resolves
      // while a `writeFile` is still in flight (which is how the CLI's own
      // teardown came to race its temp directory).
      await sessions?.flush?.()
      apns?.close()
      resolveClosed()
    },
  }
}
