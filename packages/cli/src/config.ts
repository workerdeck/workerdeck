import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProfileInfo } from '@workerdeck/protocol'
import type { WorkerServerOptions } from '@workerdeck/server'
import type { ApnsConfig } from './apns/client.ts'
import type { CliAuthOptions } from './auth.ts'

/**
 * The config surface has to be JavaScript, not JSON: the two options a real
 * deployment always needs — `authenticate` and `buildRunnerConfig` — are
 * functions. So the file default-exports `WorkerServerOptions` (optionally as a
 * function, sync or async, for config that has to await something), and flags
 * and env cover the cases that fit on a command line.
 *
 * Precedence, narrowest wins: flags > env > config file > defaults. A config
 * file that sets `authenticate` itself opts out of the built-in shared-secret
 * auth entirely — see `resolveInstanceConfig`.
 */

const CONFIG_BASENAMES = [
  'workerdeck.config.mjs',
  'workerdeck.config.js',
  'workerdeck.config.cjs',
]

/**
 * What a `workerdeck.config.mjs` default-exports: the server options, plus
 * the few instance-level settings that aren't the server's business. Keeping
 * them in one object means a deployment is one file, not a file plus a
 * memorised command line.
 */
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
   * Bind hosts that may serve without auth. One declaration, two effects:
   * binding a listed host waives the auth requirement (no key demanded, none
   * generated), and while unauthenticated every entry is also accepted as a
   * Host header, so the operator states the intent once. Entries name a host,
   * never an endpoint — a port is rejected — and match the bind host literally
   * and case-insensitively: nothing is inferred from DNS or the network, and
   * `0.0.0.0` means the all-interfaces bind itself, not "any host". When auth
   * is on this widens nothing.
   */
  insecureHosts?: string[]
  /** Serve a dashboard build from here instead of the bundled one. */
  webRoot?: string
  /**
   * Forward session notifications to Apple Push Notification service, for the
   * iOS app. Absent turns the forwarder off entirely — including its
   * `/apns/devices` route, so a gateway without this answers 404 there and the
   * app quietly stops asking.
   *
   * Lives here rather than in `packages/server` on purpose: this is the only
   * place in the project that holds a push credential, and the OSS gateway
   * stays credential-free. `keyFile` is a path, never key contents.
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
  allowedOrigins: string[]
  allowedHosts: string[]
  insecureHosts: string[]
  trustProxy?: boolean
  stateDir?: string
  parking?: boolean
  insecure?: boolean
  open?: boolean
  help?: boolean
  version?: boolean
}

export class ConfigError extends Error {}

function parsePort(raw: string, source: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`${source}: not a valid port: ${raw}`)
  }
  return port
}

/**
 * Hand-rolled rather than a dependency: the CLI's whole value is that `npx
 * workerdeck` pulls down a small tree, and an arg parser is a hundred lines
 * of it.
 */
export function parseArgs(argv: string[]): CliFlags {
  const flags: CliFlags = {
    profiles: [],
    cwdRoots: [],
    allowedOrigins: [],
    allowedHosts: [],
    insecureHosts: [],
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
        // name=dir — the config dir is a credential store, so naming one is a
        // deliberate act and never inferred.
        const raw = next(i, arg)
        i++
        const eq = raw.indexOf('=')
        if (eq <= 0) throw new ConfigError(`--profile expects name=dir, got: ${raw}`)
        const name = raw.slice(0, eq)
        const dir = raw.slice(eq + 1)
        if (!dir) throw new ConfigError(`--profile ${name}= is missing a directory`)
        flags.profiles.push({ name, configDir: resolve(dir) })
        break
      }
      case '--cwd-root':
        flags.cwdRoots.push(resolve(next(i, arg)))
        i++
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
export async function loadConfigFile(explicit?: string, cwd = process.cwd()): Promise<LoadedConfig> {
  let path: string | null = null
  if (explicit) {
    path = isAbsolute(explicit) ? explicit : resolve(cwd, explicit)
    if (!existsSync(path)) throw new ConfigError(`no config file at ${path}`)
  } else {
    path = CONFIG_BASENAMES.map((name) => join(cwd, name)).find((p) => existsSync(p)) ?? null
  }
  if (!path) return { path: null, options: {} }

  let mod: { default?: unknown }
  try {
    // The specifier is a runtime value on purpose: the config file is the
    // operator's code, not part of our module graph, so no bundler should ever
    // try to resolve or inline it.
    mod = (await import(pathToFileURL(path).href)) as { default?: unknown }
  } catch (error) {
    throw new ConfigError(
      `failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
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

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host)
}

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
   * Auth is required here but no key was supplied: `startInstance` must
   * materialize one (stored under `stateDir`, ephemeral without one). This is a
   * *promise* rather than a key because resolution is pure and synchronous while
   * reading a key file is I/O — and the promise is load-bearing: `allowedHosts`
   * is already null on the strength of it, so `startInstance` refuses to serve
   * if materialization ever fails to arm the built-in auth.
   */
  generateAuthKey: boolean
  /**
   * Host header values to accept, or null to accept any. Non-null only for an
   * unauthenticated instance — see `resolveInstanceConfig`.
   */
  allowedHosts: Set<string> | null
  /** Dashboard build to serve; resolved from the package when unset. */
  webRoot?: string
  /** APNs forwarder settings with `keyFile` made absolute, or undefined for an
   * instance that does not push. */
  apns?: ApnsConfig
  open: boolean
  options: WorkerServerOptions
}

/**
 * Durable parking is on by default because this is a long-lived instance: a
 * turnkey tool that silently drops parked work on every restart is the wrong
 * default. The store writes whole transcripts in plaintext, so it goes beside
 * the config file (or under the home directory) rather than anywhere temporary,
 * and one directory serves exactly one instance — the store is single-process
 * by design, which the single-port model already implies.
 */
export function defaultStateDir(configPath: string | null): string {
  return configPath ? join(dirname(configPath), '.workerdeck') : join(homedir(), '.workerdeck')
}

/** Hostname out of a Host header, minus the port and any IPv6 brackets. */
export function hostnameOf(hostHeader: string): string {
  try {
    return new URL(`http://${hostHeader}`).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return ''
  }
}

/** 127.0.0.0/8, ::1, and the names that mean them. */
export function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK.has(hostname)) return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * An `insecureHosts` entry names a host, never an endpoint: it is compared
 * against the bind host and against Host headers, and both are portless by the
 * time they are compared. An entry carrying a port would therefore never match
 * anything — a gate that looks armed and is not — so it is rejected loudly, as
 * is anything that does not parse as a host name or address. Bare IPv6 is
 * bracketed before parsing (WHATWG URL requires that), and the result is
 * lowercased to match `hostnameOf`'s normal form.
 */
function normalizeInsecureHost(raw: string): string {
  const entry = raw.trim()
  const looksLikeNamePort = /^[^:]+:\d+$/.test(entry)
  const candidate =
    entry.includes(':') && !entry.startsWith('[') && !looksLikeNamePort ? `[${entry}]` : entry
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

export function resolveInstanceConfig(
  flags: CliFlags,
  loaded: LoadedConfig,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ResolvedConfig {
  const envPort = env.WORKERDECK_PORT
    ? parsePort(env.WORKERDECK_PORT, 'WORKERDECK_PORT')
    : undefined
  const port = flags.port ?? envPort ?? loaded.options.port ?? 8787
  const host = flags.host ?? env.WORKERDECK_HOST ?? loaded.options.host ?? '127.0.0.1'
  // `?? undefined` would keep an empty string, and an empty secret is not a
  // secret: WORKERDECK_AUTH_KEY= in an env file means "unset", not "no auth
  // but pretend otherwise".
  const authKey =
    flags.authKey || env.WORKERDECK_AUTH_KEY || loaded.options.auth?.secret || undefined
  const hostAuthenticates = typeof loaded.options.authenticate === 'function'

  const insecureHosts = new Set(
    [...flags.insecureHosts, ...(loaded.options.insecureHosts ?? [])].map(normalizeInsecureHost),
  )
  /** The bind host in the same normal form the entries were put in. It never
   * carries a port — that is a separate flag — so only brackets and case vary. */
  const bindHost = host.trim().replace(/^\[|\]$/g, '').toLowerCase()

  // An unauthenticated Claude Code gateway on a routable interface is a shell
  // for anyone who can reach the port, so serving one takes an explicit opt-out:
  // `--insecure`, `allowUnauthenticated`, or the bind host declared in
  // `insecureHosts`. Absent all three and absent a key, auth still goes ON — a
  // key gets generated at startup rather than the old refusal, because "secure
  // by default" beats "off by default". Materializing it is I/O, which this
  // function must stay free of, so the decision is recorded as `generateAuthKey`
  // and `startInstance` does the reading and writing.
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
      : (flags.stateDir ??
        env.WORKERDECK_STATE_DIR ??
        loaded.options.stateDir ??
        defaultStateDir(loaded.path))

  const envCwdRoots = env.WORKERDECK_CWD_ROOTS?.split(':')
    .filter(Boolean)
    .map((p) => resolve(cwd, p))
  const cwdRoots = flags.cwdRoots.length ? flags.cwdRoots : envCwdRoots

  const auth: CliAuthOptions = {
    ...loaded.options.auth,
    secret: authKey,
    trustProxy: flags.trustProxy ?? loaded.options.auth?.trustProxy,
    allowedOrigins: [...(loaded.options.auth?.allowedOrigins ?? []), ...flags.allowedOrigins],
  }

  /**
   * DNS rebinding is the one attack an unauthenticated loopback instance is
   * actually exposed to: a hostile page resolves its own name to 127.0.0.1 and
   * then talks to us same-origin, with no cookie needed because nothing is
   * checked. The defence is to require the Host header to name a loopback
   * address — an attacker controls their DNS, not the name the victim's browser
   * puts in Host. With auth on this is moot (their origin holds no cookie), and
   * for a deliberately exposed instance the operator has said what they want, so
   * only the unauthenticated case is fenced.
   *
   * `generateAuthKey` counts as auth here on the promise that `startInstance`
   * materializes the key — and `startInstance` asserts the promise was kept
   * before serving. Entries are lowercased because the guard compares them
   * against `hostnameOf`'s lowercased hostnames; `insecureHosts` folds in so
   * declaring a bind host once also names it as an acceptable Host header.
   */
  const authEnabled = Boolean(authKey) || hostAuthenticates || generateAuthKey
  const allowedHosts = authEnabled
    ? null
    : new Set([
        ...LOOPBACK,
        ...[...flags.allowedHosts, ...(loaded.options.allowedHosts ?? [])].map((name) =>
          name.toLowerCase(),
        ),
        ...insecureHosts,
      ])

  // Strip the instance-level keys: what's left is exactly WorkerServerOptions.
  const {
    port: _p,
    host: _h,
    auth: _a,
    stateDir: _s,
    allowedHosts: _ah,
    insecureHosts: _ih,
    webRoot: _w,
    apns: _ap,
    ...serverOptions
  } = loaded.options
  const options: WorkerServerOptions = { ...serverOptions }
  if (cwdRoots?.length) options.allowedCwdRoots = cwdRoots
  // Flags win, but they *replace* rather than merge: a half-declared profile set
  // is a credential mix-up waiting to happen.
  if (flags.profiles.length) options.profiles = flags.profiles

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
    apns: resolveApns(loaded),
    open: flags.open ?? false,
    options,
  }
}

/**
 * A relative `keyFile` resolves against the config file's own directory, not the
 * cwd — the same convention `defaultStateDir` uses, and the one that makes a
 * deployment directory self-contained. Missing required fields throw here rather
 * than at the first push, since a half-configured forwarder is a notification
 * that silently never arrives.
 */
function resolveApns(loaded: LoadedConfig): ApnsConfig | undefined {
  const apns = loaded.options.apns
  if (!apns) return undefined
  for (const field of ['keyFile', 'keyId', 'teamId', 'topic'] as const) {
    if (typeof apns[field] !== 'string' || apns[field] === '') {
      throw new ConfigError(`apns.${field} is required when apns is configured`)
    }
  }
  const base = loaded.path ? dirname(loaded.path) : process.cwd()
  return { ...apns, keyFile: resolve(base, apns.keyFile) }
}
