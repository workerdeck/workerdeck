import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProfileInfo } from '@workerdeck/protocol'
import type { WorkerServerOptions } from '@workerdeck/server'
import type { ApnsConfig } from './apns/client.ts'
import type { CliAuthOptions } from './auth/auth.ts'

/**
 * The config surface is JavaScript, not JSON, because the options a real
 * deployment needs (`authenticate`, `buildRunnerConfig`) are functions.
 *
 * Precedence, narrowest wins: flags > env > config file > defaults. A config file
 * that sets `authenticate` opts out of the built-in shared-secret auth entirely.
 */

const CONFIG_BASENAMES = ['workerdeck.config.mjs', 'workerdeck.config.js', 'workerdeck.config.cjs']

/** What a `workerdeck.config.mjs` default-exports: the server options plus the instance-level settings. */
export type WorkerDeckConfig = WorkerServerOptions & {
  port?: number
  host?: string
  /** Built-in shared-secret auth. Ignored entirely if you supply `authenticate`. */
  auth?: CliAuthOptions
  /** Where parked sessions are persisted; null disables durable parking. */
  stateDir?: string | null
  /**
   * Host header values accepted when running *without* auth. Defaults to the
   * loopback names; see `resolveInstanceConfig` for why this exists at all.
   */
  allowedHosts?: string[]
  /**
   * Bind hosts that may serve without auth. One declaration, two effects: binding
   * a listed host waives the auth requirement, and while unauthenticated every
   * entry is also accepted as a Host header. Entries name a host, never an
   * endpoint (a port is rejected) and match the bind host literally — `0.0.0.0`
   * means the all-interfaces bind itself, never "any host". Auth on widens nothing.
   */
  insecureHosts?: string[]
  /** Serve a dashboard build from here instead of the bundled one. */
  webRoot?: string
  /**
   * Serve the web dashboard at all; default true. `false` makes this a bare
   * gateway: `/v1` and the auth routes are unchanged, everything else 404s, and
   * the dashboard build is never even looked for.
   */
  web?: boolean
  /**
   * Browser origins allowed to call this gateway cross-origin — for a dashboard
   * served somewhere else. Exact origins (`https://deck.example`), never a
   * wildcard. Refused unless auth is on: CORS on an open gateway would let any
   * allowlisted page drive it with no credential at all.
   */
  corsOrigins?: string[]
  /**
   * Forward session notifications to APNs, for the iOS app. Absent turns the
   * forwarder off entirely, and `/apns/devices` answers 404. `keyFile` is a path,
   * never key contents — this is the only push credential in the project.
   */
  apns?: ApnsConfig
}

export type CliFlags = {
  config?: string
  port?: number
  host?: string
  authKey?: string
  profiles: ProfileInfo[]
  cwdRoots: string[]
  fsRoots: string[]
  fsWrite?: boolean
  allowedOrigins: string[]
  allowedHosts: string[]
  insecureHosts: string[]
  trustProxy?: boolean
  stateDir?: string
  parking?: boolean
  insecure?: boolean
  web?: boolean
  corsOrigins: string[]
  open?: boolean
  help?: boolean
  version?: boolean
}

export class ConfigError extends Error {}

const parsePort = (raw: string, source: string): number => {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${source}: not a valid port: ${raw}`)
  }
  return port
}

/** Hand-rolled rather than a dependency: `npx workerdeck` pulling down a small tree is the point. */
export const parseArgs = (argv: string[]): CliFlags => {
  const flags: CliFlags = {
    profiles: [],
    cwdRoots: [],
    fsRoots: [],
    allowedOrigins: [],
    allowedHosts: [],
    insecureHosts: [],
    corsOrigins: [],
  }
  const next = (i: number, name: string): string => {
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new ConfigError(`${name} requires a value`)
    }
    return value
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '-h':
      case '--help':
        flags.help = true
        break
      case '-v':
      case '--version':
        flags.version = true
        break
      case '-c':
      case '--config':
        flags.config = next(i, arg)
        i++
        break
      case '-p':
      case '--port':
        flags.port = parsePort(next(i, arg), arg)
        i++
        break
      case '--host':
        flags.host = next(i, arg)
        i++
        break
      case '--auth-key':
        flags.authKey = next(i, arg)
        i++
        break
      case '--profile': {
        // name=dir — a config dir is a credential store, so naming one is deliberate, never inferred.
        const raw = next(i, arg)
        i++
        const eq = raw.indexOf('=')
        if (eq <= 0) {
          throw new ConfigError(`--profile expects name=dir, got: ${raw}`)
        }
        const name = raw.slice(0, eq)
        const dir = raw.slice(eq + 1)
        if (!dir) {
          throw new ConfigError(`--profile ${name}= is missing a directory`)
        }
        flags.profiles.push({ name, configDir: resolve(dir) })
        break
      }
      case '--cwd-root':
        flags.cwdRoots.push(resolve(next(i, arg)))
        i++
        break
      case '--fs-root':
        flags.fsRoots.push(resolve(next(i, arg)))
        i++
        break
      case '--fs-write':
        flags.fsWrite = true
        break
      case '--allowed-origin':
        flags.allowedOrigins.push(next(i, arg))
        i++
        break
      case '--allowed-host':
        flags.allowedHosts.push(next(i, arg))
        i++
        break
      case '--insecure-host':
        flags.insecureHosts.push(next(i, arg))
        i++
        break
      case '--trust-proxy':
        flags.trustProxy = true
        break
      case '--state-dir':
        flags.stateDir = resolve(next(i, arg))
        i++
        break
      case '--no-parking-store':
        flags.parking = false
        break
      case '--insecure':
        flags.insecure = true
        break
      case '--no-web':
        flags.web = false
        break
      case '--cors-origin':
        flags.corsOrigins.push(next(i, arg))
        i++
        break
      case '--open':
        flags.open = true
        break
      default:
        throw new ConfigError(`unknown option: ${arg}`)
    }
  }
  return flags
}

export type LoadedConfig = {
  /** Absolute path of the file that was loaded, or null if there wasn't one. */
  path: string | null
  options: WorkerDeckConfig
}

/**
 * Explicit `--config` must exist — a typo that silently starts a default
 * instance is worse than a failure. An implicit one is looked up in cwd only:
 * walking parent directories would make what a given command does depend on
 * where it was run from.
 */
export const loadConfigFile = async (explicit?: string, cwd = process.cwd()): Promise<LoadedConfig> => {
  let path: string | null = null
  if (explicit) {
    path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit)
    if (!existsSync(path)) {
      throw new ConfigError(`no config file at ${path}`)
    }
  } else {
    path = CONFIG_BASENAMES.map((name) => join(cwd, name)).find((p) => existsSync(p)) ?? null
  }
  if (!path) {
    return { path: null, options: {} }
  }

  let mod: { default?: unknown }
  try {
    // A runtime specifier on purpose: the config file is the operator's code, not part of our
    // module graph, so no bundler should try to resolve or inline it.
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
  } catch (error) {
    throw new ConfigError(`failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const exported = mod.default
  if (exported === undefined) {
    throw new ConfigError(`${path} has no default export (expected WorkerServerOptions)`)
  }
  const options = typeof exported === 'function' ? await (exported as () => unknown)() : exported
  if (typeof options !== 'object' || options === null) {
    throw new ConfigError(`${path} default export is not an options object`)
  }
  return { path, options: options as WorkerDeckConfig }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1'])

export const isLoopback = (host: string): boolean => LOOPBACK.has(host)

export type ResolvedConfig = {
  port: number
  host: string
  /** Shared secret, or undefined for an unauthenticated instance. */
  authKey?: string
  /** Everything else the built-in auth takes (proxy trust, extra origins). */
  auth: CliAuthOptions
  /** Where parked sessions and other instance state live; null disables durable parking. */
  stateDir: string | null
  configPath: string | null
  /** True when the config file supplied its own `authenticate` — built-in auth stands down. */
  hostAuthenticates: boolean
  /**
   * Auth is required but no key was supplied: `startInstance` must materialize
   * one. A *promise* rather than a key because resolution must stay I/O-free —
   * and load-bearing, since `allowedHosts` is already null on the strength of it.
   */
  generateAuthKey: boolean
  /**
   * Host header values to accept, or null to accept any. Non-null only for an
   * unauthenticated instance — see `resolveInstanceConfig`.
   */
  allowedHosts: Set<string> | null
  /** Dashboard build to serve; resolved from the package when unset. */
  webRoot?: string
  /** Whether to serve the dashboard at all. False makes this a bare gateway. */
  web: boolean
  /** Browser origins allowed to call this gateway cross-origin. Empty = off. */
  corsOrigins: string[]
  /** APNs forwarder settings with `keyFile` made absolute, or undefined for an
   * instance that does not push. */
  apns?: ApnsConfig
  open: boolean
  options: WorkerServerOptions
}

/**
 * The store writes whole transcripts in plaintext, so state goes beside the config
 * file (or under the home directory) rather than anywhere temporary, and one
 * directory serves exactly one instance — the store is single-process by design.
 */
export const defaultStateDir = (configPath: string | null): string =>
  configPath ? join(dirname(configPath), '.workerdeck') : join(homedir(), '.workerdeck')

/** Hostname out of a Host header, minus the port and any IPv6 brackets. */
export const hostnameOf = (hostHeader: string): string => {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

/** 127.0.0.0/8, ::1, and the names that mean them. */
export const isLoopbackHostname = (hostname: string): boolean => {
  if (LOOPBACK.has(hostname)) {
    return true
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * An entry carrying a port could never match anything the guard compares — a gate
 * that looks armed and is not — so it is rejected loudly rather than normalized
 * away. Bare IPv6 is bracketed before parsing (WHATWG URL requires it) and the
 * result lowercased to match `hostnameOf`'s normal form.
 */
const normalizeInsecureHost = (raw: string): string => {
  const entry = raw.trim()
  const looksLikeNamePort = /^[^:]+:\d+$/.test(entry)
  const candidate = entry.includes(':') && !entry.startsWith('[') && !looksLikeNamePort ? `[${entry}]` : entry
  let url: URL
  try {
    url = new URL(`http://${candidate}`)
  } catch {
    throw new ConfigError(`not a host name or address in insecureHosts: ${JSON.stringify(raw)}`)
  }
  if (url.port !== '') {
    throw new ConfigError(
      `insecureHosts entry ${JSON.stringify(raw)} carries a port — name the host alone; ` +
        `the bind host and the Host header are both compared portless`,
    )
  }
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

export const resolveInstanceConfig = (
  flags: CliFlags,
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ResolvedConfig => {
  const envPort = env.WORKERDECK_PORT ? parsePort(env.WORKERDECK_PORT, 'WORKERDECK_PORT') : undefined
  const port = flags.port ?? envPort ?? loaded.options.port ?? 8787
  const host = flags.host ?? env.WORKERDECK_HOST ?? loaded.options.host ?? '127.0.0.1'
  // `||`, not `??`: an empty secret is not a secret — `WORKERDECK_AUTH_KEY=` means "unset".
  const authKey = flags.authKey || env.WORKERDECK_AUTH_KEY || loaded.options.auth?.secret || undefined
  const hostAuthenticates = typeof loaded.options.authenticate === 'function'

  const insecureHosts = new Set([...flags.insecureHosts, ...(loaded.options.insecureHosts ?? [])].map(normalizeInsecureHost))
  /** The bind host in the normal form the entries were put in; it never carries a port. */
  const bindHost = host
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase()

  // An unauthenticated gateway on a routable interface is a shell for anyone who can reach the
  // port, so serving one takes an explicit opt-out: `--insecure`, `allowUnauthenticated`, or the
  // bind host declared in `insecureHosts`. Absent all three, auth goes ON and a key is generated.
  const generateAuthKey =
    !authKey &&
    !hostAuthenticates &&
    !loaded.options.allowUnauthenticated &&
    !isLoopback(host) &&
    !flags.insecure &&
    !insecureHosts.has(bindHost)

  const stateDir =
    flags.parking === false || loaded.options.stateDir === null
      ? null
      : (flags.stateDir ?? env.WORKERDECK_STATE_DIR ?? loaded.options.stateDir ?? defaultStateDir(loaded.path))

  const envCwdRoots = env.WORKERDECK_CWD_ROOTS?.split(':')
    .filter(Boolean)
    .map((p) => resolve(cwd, p))
  const cwdRoots = flags.cwdRoots.length ? flags.cwdRoots : envCwdRoots

  // --fs-root *narrows* file access; it does not enable it. Reading follows
  // --cwd-root, since a caller who may start a session in a tree can already read
  // that tree through the agent. Writing still needs --fs-write.
  const envFsRoots = env.WORKERDECK_FS_ROOTS?.split(':')
    .filter(Boolean)
    .map((p) => resolve(cwd, p))
  const fsRoots = flags.fsRoots.length ? flags.fsRoots : envFsRoots

  const auth: CliAuthOptions = {
    ...loaded.options.auth,
    secret: authKey,
    trustProxy: flags.trustProxy ?? loaded.options.auth?.trustProxy,
    allowedOrigins: [...(loaded.options.auth?.allowedOrigins ?? []), ...flags.allowedOrigins],
  }

  /**
   * Only the unauthenticated case is fenced, and DNS rebinding is what it is fenced
   * against: a hostile page resolving its own name to 127.0.0.1 talks to a keyless
   * instance same-origin. `generateAuthKey` counts as auth here on the promise that
   * `startInstance` materializes the key, and `startInstance` asserts it was kept.
   */
  const authEnabled = Boolean(authKey) || hostAuthenticates || generateAuthKey
  const allowedHosts = authEnabled
    ? null
    : new Set([
        ...LOOPBACK,
        ...[...flags.allowedHosts, ...(loaded.options.allowedHosts ?? [])].map((name) => name.toLowerCase()),
        ...insecureHosts,
      ])

  // Flag wins over config file, which wins over the turnkey default.
  const web = flags.web ?? loaded.options.web ?? true

  const corsOrigins = flags.corsOrigins.length ? flags.corsOrigins : (loaded.options.corsOrigins ?? [])
  for (const origin of corsOrigins) {
    // Exactness is the guarantee: a wildcard hands the API to every page that can reach this
    // port, and a bare hostname is not an origin — browsers send and compare scheme+host+port.
    if (origin === '*') {
      throw new ConfigError('--cors-origin does not accept "*"')
    }
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new ConfigError(`--cors-origin expects a full origin, got: ${origin}`)
    }
    if (parsed.origin !== origin) {
      throw new ConfigError(`--cors-origin expects scheme://host[:port] with no path, got: ${origin}`)
    }
  }
  // Naming both is a mistake, not a preference to resolve: we cannot tell which one was meant.
  if (!web && flags.open) {
    throw new ConfigError('--open cannot be used with --no-web: there is no dashboard to open')
  }

  // Strip the instance-level keys: what's left is exactly WorkerServerOptions.
  const {
    port: _p,
    host: _h,
    auth: _a,
    stateDir: _s,
    allowedHosts: _ah,
    insecureHosts: _ih,
    webRoot: _w,
    web: _web,
    corsOrigins: _cors,
    apns: _ap,
    ...serverOptions
  } = loaded.options
  const options: WorkerServerOptions = { ...serverOptions }
  if (cwdRoots?.length) {
    options.allowedCwdRoots = cwdRoots
  }
  if (fsRoots?.length || flags.fsWrite) {
    options.hostFiles = {
      ...loaded.options.hostFiles,
      ...(fsRoots?.length ? { roots: fsRoots } : {}),
      ...(flags.fsWrite ? { write: true } : {}),
    }
  }
  // Flags *replace* rather than merge: a half-declared profile set is a credential mix-up.
  if (flags.profiles.length) {
    options.profiles = flags.profiles
  }

  return {
    port,
    host,
    authKey,
    auth,
    stateDir,
    configPath: loaded.path,
    hostAuthenticates,
    generateAuthKey,
    allowedHosts,
    webRoot: loaded.options.webRoot,
    web,
    corsOrigins,
    apns: resolveApns(loaded),
    open: flags.open ?? false,
    options,
  }
}

/**
 * A relative `keyFile` resolves against the config file's directory, not the cwd,
 * so a deployment directory stays self-contained. Missing fields throw here rather
 * than at the first push, which would be a notification that silently never arrives.
 */
const resolveApns = (loaded: LoadedConfig): ApnsConfig | undefined => {
  const apns = loaded.options.apns
  if (!apns) {
    return undefined
  }
  for (const field of ['keyFile', 'keyId', 'teamId', 'topic'] as const) {
    if (typeof apns[field] !== 'string' || apns[field] === '') {
      throw new ConfigError(`apns.${field} is required when apns is configured`)
    }
  }
  const base = loaded.path ? dirname(loaded.path) : process.cwd()
  return { ...apns, keyFile: resolve(base, apns.keyFile) }
}
