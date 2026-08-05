import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  type Dirent,
} from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { Duplex } from 'node:stream'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
import { checkClaudeAuth } from '@workerdeck/core'
import type {
  ClaudeAuthProbe,
  Runner,
  RunnerSnapshot,
  SessionRunnerConfig,
  ToolExecutionResult,
} from '@workerdeck/core'
import { JobQueue, type QueueAdapter } from '@workerdeck/queue'
import {
  PROTOCOL_VERSION,
  PROVIDER_PERMISSION_MODES,
  supportsPermissionMode,
  type ClientFrame,
  type CreateJobRequest,
  type CreateSessionRequest,
  type JobEvent,
  type ModelOption,
  type PermissionMode,
  type ProfileConfigSnapshot,
  type ProfileInfo,
  type QueueServerFrame,
  type McpServerActionRequest,
  type ResolvePermissionRequest,
  type SdkSessionSummary,
  type ServerFrame,
  type SubmitExecutionResultRequest,
  type UpdateProfileRequest,
  type WriteHostFileRequest,
} from '@workerdeck/protocol'
import { searchFiles } from './host-file-search.ts'
import {
  createHostFileRoots,
  entryKind,
  readContained,
  resolveExisting,
  resolveForWrite,
  writeContained,
} from './host-files.ts'
import { AttachmentStore } from './attachments.ts'
import { SessionRegistry } from './registry.ts'
import { SessionNotifier, type SessionNotificationOptions } from './notifications.ts'
import { BridgeHub, type BridgeHubOptions } from './bridge.ts'
import { SessionParkManager } from './parking.ts'
import { MemorySessionStore, type SessionStore } from './session-store.ts'
import type { ProfileStore } from './profile-store.ts'

export type SdkSessionLister = (options: {
  dir?: string
  limit?: number
  offset?: number
}) => Promise<SdkSessionSummary[]>

const defaultSdkSessionLister: SdkSessionLister = async (options) => {
  const sessions = await sdkListSessions(options)
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    customTitle: s.customTitle,
    firstPrompt: s.firstPrompt,
    gitBranch: s.gitBranch,
    cwd: s.cwd,
  }))
}

/**
 * Return a principal (any truthy value) to accept the request, or null/undefined to
 * reject with 401. The host app supplies this — the worker has no auth story of its
 * own. A principal object may carry `allowedProfiles: string[]` to restrict which
 * profiles the caller can create sessions/jobs under (and see in GET /profiles) —
 * without it the caller may use every declared profile. It may also carry
 * `canManageProfiles: true` to allow creating/editing/deleting managed profiles
 * (requires the `profileStore` option); anything else means no.
 */
export type Authenticator = (
  req: IncomingMessage,
) => unknown | Promise<unknown>

export type WorkerServerOptions = {
  /** Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. */
  authenticate?: Authenticator
  /** Explicit opt-in to run without auth (local dev only). */
  allowUnauthenticated?: boolean
  /** If set, session cwd must resolve inside one of these roots. Strongly recommended. */
  allowedCwdRoots?: string[]
  /**
   * The host filesystem routes (`{basePath}/fs/*`) — browse and read the
   * operator's real project tree, and optionally write to it.
   *
   * **Reading follows {@link allowedCwdRoots} and needs no grant of its own.**
   * A caller holding the auth key can already start a session in any allowed root
   * and have the agent read whatever is in it, so serving those same trees over
   * `/fs` adds no authority — it only removes the absurdity of going through a
   * language model to `cat` a file. Set `roots` here only to *narrow* that (or to
   * expose a tree sessions may not run in).
   *
   * With neither set the routes 404. That is not the same as inheriting
   * `allowedCwdRoots`' permissive "unset means anywhere": no cwd policy means
   * there is nothing to inherit, and "anywhere" is a statement about paths the
   * operator types at a keyboard, not one about what a phone may read.
   *
   * **Writing is a separate opt-in**, because it is the one part that is not
   * already implied. An agent's writes go through the permission flow; a `PUT` to
   * `/fs/write` does not. These routes are operator-privileged by design — the
   * caller is the operator — but that is a reason to make the bypass deliberate,
   * not a reason to skip the switch.
   *
   * Containment is *not* `cwdAllowed`, whichever roots are in play: these routes
   * walk paths the agent may have authored, so a symlink can escape a lexical
   * prefix check. See `host-files.ts` — canonicalize, then re-check.
   */
  hostFiles?: {
    /** Absolute paths. Unset inherits {@link allowedCwdRoots}; an explicit empty
     * array disables the routes (a policy, not an absence). */
    roots?: string[]
    /** Enable `PUT {basePath}/fs/write`. Default false — read-only. */
    write?: boolean
    /** Refuse reads above this (413) rather than streaming a gigabyte to a phone.
     * Default 1 MiB. Writes are bounded by {@link maxBodyBytes} instead. */
    maxFileBytes?: number
    /** Cap on entries returned per directory (the response says `truncated`).
     * Default 5000. */
    maxEntries?: number
    /** Directory names `GET /fs/find` will not descend into. Defaults to
     * `DEFAULT_IGNORED_DIRS` (`.git`, `node_modules`, build output…) — the thing
     * that keeps a per-keystroke search cheap on a real source tree. */
    ignore?: string[]
  }
  /**
   * Message attachments (`{basePath}/sessions/:id/attachments`) — the photos and
   * files a client sends alongside a message. Always on; these knobs only size it.
   *
   * There is no grant to make here the way `hostFiles.write` is one: an upload
   * lands in the session's own in-memory hold and reaches the model as message
   * content, which is exactly what typing does. What it *can* do is cost memory,
   * so both caps default low enough that a phone camera roll cannot fill the
   * gateway.
   */
  attachments?: {
    /** Largest single upload; over it is a 413. Default 10 MiB. */
    maxFileBytes?: number
    /** Ceiling on what one session holds at once. Default 64 MiB. */
    maxSessionBytes?: number
  }
  /**
   * Named Claude Code config directories sessions can run under (each becomes the
   * session's CLAUDE_CONFIG_DIR — settings, memory, skills, and the credentials the
   * SDK resolves from it). Declared here at startup; the API only reads them
   * (GET {basePath}/profiles). With more than one declared, every session/job create
   * must name its profile; with exactly one it is implicit. Unset: a 'default'
   * profile is auto-created from $CLAUDE_CONFIG_DIR or ~/.claude when that directory
   * exists. Pass [] to run without profiles (no env pinning at all).
   */
  profiles?: ProfileInfo[]
  /**
   * Persistence for dashboard-managed profiles, which mounts the profile
   * management routes (`POST /profiles`, `PATCH`/`DELETE /profiles/:name`).
   * Without it the profile set is startup config and the API stays read-only.
   *
   * Profiles declared in `profiles` are never stored and never editable over
   * HTTP — they are code. The two sets are unioned by name, declared winning.
   * Callers still need `canManageProfiles` on their principal.
   */
  profileStore?: ProfileStore
  /**
   * Config-dir roots a *managed* Claude profile's `configDir` must resolve inside
   * (mirrors {@link allowedCwdRoots}). Unset — the default — means the management
   * routes create provider profiles only: naming a config directory is choosing
   * which credential store a session runs on, so it stays operator-bounded.
   * Declared profiles are unaffected.
   */
  allowedConfigDirRoots?: string[]
  /** Map/patch the incoming CreateSessionRequest into the runner config (inject queryFn,
   * env, tool policy, per-skill constraints...). Defaults to identity.
   *
   * What this hook injects is **not** durable: a session rebuilt from a parked
   * record is built from the stored config, and a durable store persists neither
   * `env` nor injected functions (see `toDurableRecord` in session-store.ts). That costs the
   * Claude engine nothing, since it cannot park — but a provider host that
   * resolves credentials into `config.env` here for its `createEngineRunner` to
   * read back loses them on the wake. Resolve them in the factory instead. */
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  /** URL prefix for all routes. Default '/v1'. */
  basePath?: string
  /**
   * Handle requests that fall outside `basePath` instead of 404ing them. The
   * turnkey CLI serves the dashboard through this, which is the whole reason it
   * exists: a browser cannot put a header on a WebSocket handshake, so the only
   * credential a tab can present on a session attach is a cookie — and a cookie
   * only rides requests to the origin that set it. Serving the app and the API
   * from one origin is therefore not a convenience, it is what makes an
   * authenticated dashboard possible without a stamping proxy in front.
   *
   * Upgrades are not routed here: anything outside `basePath` is still refused.
   */
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  /** Max JSON body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /**
   * Server-wide bypass policy: refuse `permissionMode: 'bypassPermissions'` on
   * session/job creation (403), and strip the `allowDangerouslySkipPermissions`
   * pre-authorization from requests (so clients that ask for the capability by
   * default keep working — their later switch attempt fails with the CLI's own
   * visible error instead). Mirrors Claude Code's
   * `permissions.disableBypassPermissionsMode` setting, enforced at the gateway.
   */
  disableBypassPermissions?: boolean
  /**
   * Fail closed on subscription credentials: if a session initializes with
   * `apiKeySource: 'oauth'` (a claude.ai login rather than an API key / Bedrock / Vertex),
   * it is terminated with a session_error. Recommended for services and any
   * unattended/scheduled use — Anthropic's terms require API-key auth for those.
   * Off by default: single-user personal deployments may legitimately run on the
   * operator's own subscription; the server then logs a one-time notice instead.
   */
  requireApiKey?: boolean
  /**
   * Launch-time credential sanity check: once `listen()` binds, each Claude
   * profile's session environment — exactly what `buildRunnerConfig` would hand
   * a session, host hook included — is probed with the SDK-bundled CLI's
   * `claude auth status`, concurrently and fire-and-forget, and a profile that
   * reports logged-out gets one console warning. Warn, never fail: the operator
   * may be about to log in, and a probe that cannot run at all (missing binary,
   * a CLI without `auth status`, unparseable output) stays silent — "couldn't
   * check" is not "not logged in". No credential material is read or logged.
   * Off by default (this is a library; tests must spawn nothing) — the turnkey
   * CLI turns it on. Pass an object to inject the probe (tests) or a timeout.
   */
  checkCredentials?: boolean | { probe?: ClaudeAuthProbe; timeoutMs?: number }
  /** Injectable lister for GET /sdk-sessions (tests). Defaults to the SDK's listSessions,
   * which reads the Agent SDK's on-disk session store. */
  listSdkSessions?: SdkSessionLister
  /** Enable the job queue (`/jobs` + `/queue` routes). Jobs run as ordinary registry
   * sessions — attachable over the sessions WS — governed by these limits. */
  queue?: QueueServerOptions
  /**
   * Out-of-band notification for interactive sessions: the four moments a person
   * away from the screen needs (permission requested, turn done, error, closed)
   * POSTed to a webhook and/or handed to a local observer. Off unless configured.
   *
   * Server-wide, unlike the queue's per-job webhook — the point is to hear about
   * sessions you neither created nor are attached to, which is the situation a
   * mobile client is in permanently (iOS will not hold a WebSocket open in the
   * background). Every registry session qualifies, job runs included, so a job
   * carrying its own webhook is reported on both channels.
   *
   * This is the primitive, and it stays transport-agnostic on purpose: the OSS
   * server holds no push credentials. Turning a notification into an APNs push is
   * a forwarder's job — see the turnkey CLI.
   */
  notifications?: SessionNotificationOptions
  /** Browser-bridged tool execution: how long a bridged call may go unanswered
   * before it fails (default 60000), and where terminal results are delivered.
   * The hub is always available on the returned server as `bridge`. */
  bridge?: BridgeHubOptions
  /**
   * Deferred execution: a session that parks on an execution nothing here is
   * running has its state persisted and its runner torn down, and comes back when
   * the result is POSTed to `{basePath}/executions/:executionId/result`.
   *
   * On by default with an in-memory store, so a park survives a disconnect but not
   * a restart; pass `store: createFileSessionStore()` (or your own) to change that
   * — read its doc first, the record holds the whole transcript.
   */
  parking?: {
    store?: SessionStore
    /** Grace after the last client detaches before parking. Default 2000. */
    parkDelayMs?: number
    /** Grace given on boot to an execution whose deadline passed while the server
     * was down (durable stores only — nothing else survives a restart). Default 60000. */
    expiredGraceMs?: number
    /** Park/resume failures — storage or engine-assembly problems, not session errors. */
    onError?: (error: unknown, context: { sessionId: string; phase: 'park' | 'resume' }) => void
  }
  /**
   * Build a runner for a `provider` profile (the model-agnostic engine).
   * Required if any such profile is declared — the server refuses to start
   * otherwise, rather than failing at create time.
   *
   * Kept as a host hook so the server package neither imports a model SDK nor
   * decides how provider credentials are resolved: the factory reads them from
   * the operator's environment, exactly like the Claude credential chain.
   *
   * May be async: assembly that has to await — a per-session MCP connect, a
   * credential lookup — belongs here, with `AiSdkRunnerConfig.onClose` as the
   * disposer. A rejection fails the create — the session POST answers 500 with
   * the message, a job goes straight to `failed`.
   */
  createEngineRunner?: (context: EngineRunnerContext) => Runner | Promise<Runner>
}

export type EngineRunnerContext = {
  /** The session config, with profile defaults already applied. */
  config: SessionRunnerConfig
  /** The profile that selected this engine. */
  profile: ProfileInfo
  /** Bridge hub, for handing the runner a browser-backed ToolExecutor
   * (`bridge.executorFor(sessionId)`). */
  bridge: BridgeHub
  /**
   * Set when rebuilding a session that parked on a deferred execution. Forward it
   * as `restore` on the engine config (`createEngineSession({ config: { ...config,
   * restore } })`) — the engine then adopts the session's id, event log, seq
   * numbering, history, and scratch filesystem instead of starting fresh.
   */
  restore?: RunnerSnapshot
}

export type QueueServerOptions = {
  /** Concurrent job sessions. Default 1. */
  maxConcurrency?: number
  /** Token cap per job session (input+output+cache tokens); exceeding it kills the run. */
  sessionTokenLimit?: number
  /** Global job-token budget per UTC day; queued jobs are held once exhausted. */
  dailyTokenLimit?: number
  /** Wall-clock cap per job run — the watchdog against stuck CLIs. */
  maxJobDurationMs?: number
  /** Grace between interrupting a killed run and force-closing it. Default 5000. */
  killGraceMs?: number
  /** Expire terminal jobs after `maxAgeMs` (the in-memory adapter otherwise grows
   * unboundedly). */
  retention?: { maxAgeMs: number; sweepIntervalMs?: number }
  /** Queue backend. Defaults to the bundled in-memory adapter (single process,
   * no persistence) — redis/bullmq/pubsub adapters implement the same interface. */
  adapter?: QueueAdapter
  /** Webhook delivery attempts per event (default 3, exponential backoff). */
  webhookAttempts?: number
  webhookRetryDelayMs?: number
  /** Local observer for job lifecycle events (in addition to per-job webhooks). */
  onEvent?: (event: JobEvent) => void
}

export type WorkerServer = {
  server: Server
  registry: SessionRegistry
  /** The job queue, when `queue` options were provided. */
  queue?: JobQueue
  /** Routes tool executions to attached browser clients. `bridge.executorFor(id)`
   * is the `ToolExecutor` to hand a runner that should execute in the tab. */
  bridge: BridgeHub
  /** Parked sessions: the store, the execution index, and the rehydration path.
   * Deliver a deferred result with `parking.submitResult(...)` in-process, or POST
   * it to `{basePath}/executions/:executionId/result`. */
  parking: SessionParkManager
  listen: (port: number, host?: string) => Promise<{ port: number }>
  close: () => Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** Body as bytes, refusing anything over `maxBytes`. Attachments are the one
 * thing this server takes that isn't JSON. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * Curated, view-only snapshot of a profile's config dir for GET /profiles/:name.
 * Best-effort: a missing or unparseable settings.json just omits the settings block.
 * Env var VALUES are never read into the response — names only.
 *
 * Provider profiles have no config dir, so the snapshot is empty for them: their
 * configuration is the `provider` block already on ProfileInfo.
 */
function readProfileConfig(profile: ProfileInfo): ProfileConfigSnapshot {
  const dir = profile.configDir
  if (!dir) return { hasUserMemory: false, skills: [], agents: [], commands: [] }
  const listDirs = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  const listMd = (path: string): string[] => {
    try {
      return readdirSync(path)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }
  const snapshot: ProfileConfigSnapshot = {
    hasUserMemory: existsSync(join(dir, 'CLAUDE.md')),
    skills: listDirs(join(dir, 'skills')),
    agents: listMd(join(dir, 'agents')),
    commands: listMd(join(dir, 'commands')),
  }
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const permissions = (raw.permissions ?? {}) as Record<string, unknown>
    const count = (rules: unknown): number => (Array.isArray(rules) ? rules.length : 0)
    snapshot.settings = {
      model: typeof raw.model === 'string' ? raw.model : undefined,
      defaultPermissionMode:
        typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined,
      permissionRules: {
        allow: count(permissions.allow),
        ask: count(permissions.ask),
        deny: count(permissions.deny),
      },
      envKeys:
        raw.env && typeof raw.env === 'object' ? Object.keys(raw.env).sort() : undefined,
      hooks:
        raw.hooks && typeof raw.hooks === 'object' ? Object.keys(raw.hooks).sort() : undefined,
    }
  } catch {
    // settings.json absent or unparseable — snapshot ships without the block
  }
  return snapshot
}

/** Conservative content types for VFS downloads: text formats the agent actually
 * produces; anything unrecognized ships as plain text (the VFS is string-backed). */
const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
}

/** sha256 hex — the currency of the conditional-write protocol on `/fs/write`. */
function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The file's text, or null if it isn't text. Decoding never fails in Node — invalid
 * bytes become U+FFFD — so the only honest test is a round trip: if re-encoding the
 * decoded string reproduces the original bytes, nothing was lost and the client can
 * safely edit and send it back. Anything else ships base64, which an editor can
 * refuse to open rather than silently corrupt on save.
 */
function asUtf8(bytes: Buffer): string | null {
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

function contentTypeFor(filename: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return CONTENT_TYPES[ext] ?? 'text/plain; charset=utf-8'
}

/** A profile runs the model-agnostic engine rather than Claude Code. `engine` is
 * optional so profiles written before provider support keep meaning 'claude'. */
function isProviderProfile(profile: ProfileInfo): boolean {
  return profile.engine === 'provider'
}

/** Where the CLI's own resolution lands for a given environment: an explicit
 * CLAUDE_CONFIG_DIR, else ~/.claude. */
function cliConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

/** Auto-created profile when none are declared: the operator's own config dir. */
function detectDefaultProfiles(): ProfileInfo[] {
  const dir = cliConfigDir(process.env)
  return existsSync(dir) ? [{ name: 'default', configDir: dir }] : []
}

/** Compare config dirs by what they name on disk: declared paths arrive with
 * trailing slashes or symlinked prefixes (`/var` vs `/private/var` on macOS); a
 * path that doesn't exist falls back to plain normalization. */
function canonicalDir(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolvePath(path)
  }
}

/**
 * The env a Claude session under `profile` is spawned with, starting from
 * `base` (the host hook's env, else the server's own). The pin is skipped when
 * `base` would already land the CLI in the profile's dir, and that skip is
 * load-bearing, not an optimisation: CLAUDE_CONFIG_DIR *set at all* switches
 * the CLI's credential source to `<dir>/.credentials.json` — on macOS a
 * claude.ai login lives in the login Keychain, consulted only while the
 * variable is UNSET, so pinning even the CLI's own default `~/.claude` turns a
 * working login into "Not logged in". When `base` names a *different* dir than
 * the profile, the pin stands: the profile must win over hook- or operator-set
 * env, or sessions under two profiles quietly collapse into one identity.
 */
function claudeSessionEnv(
  profile: ProfileInfo,
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return canonicalDir(profile.configDir!) === canonicalDir(cliConfigDir(base))
    ? base
    : { ...base, CLAUDE_CONFIG_DIR: profile.configDir! }
}

function cwdAllowed(cwd: string, roots: string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true
  const resolved = resolvePath(cwd)
  return roots.some((root) => {
    const r = resolvePath(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
}

export function createWorkerServer(options: WorkerServerOptions = {}): WorkerServer {
  if (!options.authenticate && !options.allowUnauthenticated) {
    throw new Error(
      'createWorkerServer: provide `authenticate` or explicitly set `allowUnauthenticated: true`',
    )
  }
  const basePath = options.basePath ?? '/v1'
  const fallback = options.fallback
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const hostBuildRunnerConfig =
    options.buildRunnerConfig ?? ((req: CreateSessionRequest): SessionRunnerConfig => req)

  // Profiles: declared at startup, or a single 'default' auto-created from the
  // operator's own config dir. Misdeclared dirs fail fast — the CLI would otherwise
  // silently start from an empty config (and a different credential chain).
  const declared = options.profiles ?? detectDefaultProfiles()
  const declaredByName = new Map(declared.map((p) => [p.name, p]))
  if (declaredByName.size !== declared.length) {
    throw new Error('createWorkerServer: duplicate profile names in `profiles`')
  }

  /**
   * Everything wrong with a profile that the server can tell without running it.
   * Shared by startup (where it throws) and the management routes (where it 400s),
   * so a profile created over HTTP can never be one startup would have refused.
   */
  const validateProfile = (p: ProfileInfo): string | null => {
    if (isProviderProfile(p)) {
      // Provider profiles have no config dir; they need an engine factory to
      // build a runner at all, so refuse up front rather than at create time.
      if (!p.provider?.id) return `provider profile '${p.name}' is missing provider.id`
      if (!options.createEngineRunner) {
        return (
          `profile '${p.name}' uses engine 'provider' but no ` +
          '`createEngineRunner` was provided to build one'
        )
      }
    } else if (!p.configDir || !existsSync(p.configDir)) {
      return `profile '${p.name}' configDir does not exist: ${p.configDir}`
    }
    if (options.disableBypassPermissions && p.defaults?.permissionMode === 'bypassPermissions') {
      return `profile '${p.name}' defaults to bypassPermissions but disableBypassPermissions is set`
    }
    // A default the profile's own engine can't run is misconfiguration: catch it
    // here rather than on every create under that profile.
    const fallbackMode = p.defaults?.permissionMode
    if (fallbackMode && !supportsPermissionMode(p.engine, fallbackMode)) {
      return (
        `profile '${p.name}' defaults to permission mode '${fallbackMode}', which engine ` +
        `'${p.engine}' does not support (supported: ${PROVIDER_PERMISSION_MODES.join(', ')})`
      )
    }
    return null
  }

  for (const p of options.profiles ?? []) {
    const invalid = validateProfile(p)
    if (invalid) throw new Error(`createWorkerServer: ${invalid}`)
  }

  /**
   * Store-managed profiles, mirrored in memory so every lookup on the request path
   * stays synchronous. Loaded once at `listen()` and refreshed after each mutation
   * — single-process, exactly like the bundled queue adapter.
   */
  const stored = new Map<string, ProfileInfo>()
  const refreshStored = async (): Promise<void> => {
    if (!options.profileStore) return
    stored.clear()
    for (const p of await options.profileStore.list()) stored.set(p.name, p)
  }

  /** Response-only marker so a UI knows which rows it may edit. Declared profiles
   * are code; only store-backed ones can be changed over the API. */
  const withManagedFlag = (p: ProfileInfo): ProfileInfo =>
    declaredByName.has(p.name) ? p : { ...p, managed: true }

  /** Response shape for a profile: the managed marker, plus whatever models a
   * session on it has reported. Read-only decoration — never persisted. */
  const forResponse = (p: ProfileInfo): ProfileInfo => {
    const seen = profileModels.get(p.name)
    const base = withManagedFlag(p)
    return seen ? { ...base, models: seen.models, defaultModel: seen.defaultModel } : base
  }

  /** Declared profiles first: a name collision means the code wins, and the stored
   * one is unreachable rather than silently overriding server options. */
  const allProfiles = (): ProfileInfo[] => [
    ...declared,
    ...[...stored.values()].filter((p) => !declaredByName.has(p.name)),
  ]
  const profileFor = (name: string): ProfileInfo | undefined =>
    declaredByName.get(name) ?? stored.get(name)

  type Refusal = { status: number; error: string }

  /** Profile management is doubly opt-in: the operator wires a store, and the host
   * marks the principal. Neither on its own is enough. */
  const manageGuard = (auth: { canManageProfiles?: boolean }): Refusal | null => {
    if (!options.profileStore) {
      return { status: 404, error: 'profile management is not enabled on this server' }
    }
    if (!auth.canManageProfiles) {
      return { status: 403, error: 'not allowed to manage profiles' }
    }
    return null
  }

  /** Startup-declared profiles are code. Editing one over HTTP would make the
   * server options lie about what is actually running. */
  const declaredGuard = (profile: ProfileInfo): Refusal | null =>
    declaredByName.has(profile.name)
      ? {
          status: 403,
          error:
            `profile '${profile.name}' is declared in server options and cannot be changed ` +
            'over the API — edit the `profiles` option instead',
        }
      : null

  /**
   * A managed Claude profile names a config directory, and that directory is a
   * credential store. Bound it to operator-declared roots; unset roots means the
   * management routes create provider profiles only.
   */
  const configDirGuard = (profile: ProfileInfo): Refusal | null => {
    if (isProviderProfile(profile)) return null
    const roots = options.allowedConfigDirRoots
    if (!roots || roots.length === 0) {
      return {
        status: 403,
        error:
          'managed Claude profiles are disabled: set `allowedConfigDirRoots` to the ' +
          'directories they may point at',
      }
    }
    return profile.configDir && cwdAllowed(profile.configDir, roots)
      ? null
      : { status: 403, error: 'configDir is outside the allowed roots' }
  }

  /** Validate, persist, and re-read: shared by create and update so a PATCH can
   * never leave behind a profile a POST would have refused. */
  const saveManagedProfile = async (res: ServerResponse, incoming: ProfileInfo): Promise<void> => {
    // `managed` is server-computed on every response; never persist a client's copy.
    const { managed: _clientClaim, ...profile } = incoming
    const refused = configDirGuard(profile)
    if (refused) {
      json(res, refused.status, { error: refused.error })
      return
    }
    const invalid = validateProfile(profile)
    if (invalid) {
      json(res, 400, { error: invalid })
      return
    }
    await options.profileStore!.save(profile)
    await refreshStored()
    json(res, 200, { profile: withManagedFlag(profile) })
  }

  /** Enforce the server's bypass policy on a create request. Returns a 403 message
   * for an explicit bypass-mode request; strips the pre-authorization capability
   * silently (see the option's doc for why). */
  const applyBypassPolicy = (req: CreateSessionRequest): string | null => {
    if (!options.disableBypassPermissions) return null
    if (req.permissionMode === 'bypassPermissions') {
      return 'bypassPermissions is disabled on this server (disableBypassPermissions)'
    }
    delete req.allowDangerouslySkipPermissions
    return null
  }

  /** Reject a permission mode the resolved profile's engine has no meaning for.
   * The create form already filters what it offers, but the API is the boundary:
   * a provider session asked for 'plan' should be told so, not silently coerced
   * into 'default' by whatever assembles its runner. Returns an error message. */
  const checkPermissionMode = (
    mode: PermissionMode | undefined,
    profile: ProfileInfo | undefined,
  ): string | null => {
    if (mode === undefined || supportsPermissionMode(profile?.engine, mode)) return null
    return (
      `permission mode '${mode}' is not supported by profile '${profile!.name}' ` +
      `(engine '${profile!.engine}') — supported: ${PROVIDER_PERMISSION_MODES.join(', ')}`
    )
  }

  /**
   * Enforce the provider engine's grant rules on a create request. Two of them:
   *
   * - Capabilities narrow, never widen. A request may run with fewer than the
   *   profile grants; naming one it doesn't is refused rather than quietly
   *   downgraded, so a caller learns instead of wondering where the tool went.
   * - MCP servers are the profile's to declare. MCP tools are authoritative —
   *   server-side, with server credentials, never bridged — so honoring a
   *   client-supplied server would let a caller point an authoritative tool
   *   anywhere it liked. The profile names servers; the host holds their configs.
   */
  const checkEngineGrants = (
    req: CreateSessionRequest,
    profile: ProfileInfo | undefined,
  ): string | null => {
    if (!profile || !isProviderProfile(profile)) return null
    if (req.mcpServers && Object.keys(req.mcpServers).length > 0) {
      return (
        `profile '${profile.name}' runs the provider engine, whose MCP servers are declared ` +
        'on the profile (session.mcpServers) — a session request cannot add its own'
      )
    }
    const granted = profile.session?.capabilities
    if (!req.capabilities || !granted) return null
    const ungranted = req.capabilities.filter((c) => !granted.includes(c))
    if (ungranted.length === 0) return null
    return (
      `profile '${profile.name}' does not grant: ${ungranted.join(', ')} ` +
      `(granted: ${granted.join(', ') || 'none'}) — a request may narrow capabilities, not widen them`
    )
  }

  /** Profile-aware config hook: fill the profile's defaults into unset request fields,
   * run the host hook, then pin CLAUDE_CONFIG_DIR — the profile wins even when the
   * host hook set its own env (see `claudeSessionEnv` for the one case the pin is
   * skipped, and why). Handed to the queue too, so jobs inherit profiles. */
  const buildRunnerConfig = (req: CreateSessionRequest): SessionRunnerConfig => {
    const profile = req.profile !== undefined ? profileFor(req.profile) : undefined
    if (!profile) return hostBuildRunnerConfig(req)
    const config = hostBuildRunnerConfig({
      ...req,
      model: req.model ?? profile.defaults?.model ?? profile.provider?.model,
      permissionMode: req.permissionMode ?? profile.defaults?.permissionMode,
    })
    // Provider profiles have no config dir to pin: their credentials come from
    // the operator's environment through the engine factory.
    if (isProviderProfile(profile)) return config
    const base = config.env ?? process.env
    const env = claudeSessionEnv(profile, base)
    // A skipped pin returns `base` itself — leave the config alone so an unset
    // `env` stays unset (the SDK then spawns on process.env, unmaterialized).
    return env === base ? config : { ...config, env }
  }

  /** Build a runner for a session, choosing the engine from its profile. Async
   * because the engine factory may be: a provider session can need an awaited
   * assembly step (per-session MCP connect) before it has a runner at all.
   *
   * `restore` rebuilds a parked session rather than creating a new one — same id,
   * same log, mid-task. */
  const buildRunner = async (
    config: SessionRunnerConfig,
    restore?: RunnerSnapshot,
  ): Promise<Runner> => {
    const name = config.profile
    const profile = name !== undefined ? profileFor(name) : undefined
    if (name !== undefined && !profile) {
      // Only reachable on a resume: profiles can be deleted between park and
      // wake-up, and the session cannot be rebuilt without the one it ran on.
      throw new Error(`unknown profile: ${name}`)
    }
    if (profile && isProviderProfile(profile)) {
      // Guaranteed present: startup refuses provider profiles without a factory.
      return options.createEngineRunner!({ config, profile, bridge, restore })
    }
    if (restore) throw new Error('the Claude engine cannot rebuild a parked session')
    return new Promise<Runner>((resolve) => resolve(registry.prepare(config)))
  }

  const createRunner = async (config: SessionRunnerConfig): Promise<Runner> => {
    const runner = registry.register(await buildRunner(config))
    // Watchers first, then start: a session must not emit anything before the
    // things that persist and account for it are listening.
    parking.remember(runner.id, config)
    parking.watch(runner)
    void runner.start()
    return runner
  }

  /** Resolve a request's profile: required when several are declared, implicit with
   * exactly one, scoped by the principal's allowedProfiles. Returns the resolved
   * profile (undefined when the server declares none) or a response-ready error. */
  const resolveProfile = (
    name: unknown,
    allowedProfiles: string[] | undefined,
  ): { ok: true; profile?: ProfileInfo } | { ok: false; status: number; error: string } => {
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, status: 400, error: 'profile must be a string' }
    }
    const profiles = allProfiles()
    if (profiles.length === 0) {
      return name !== undefined
        ? { ok: false, status: 400, error: 'no profiles are configured on this server' }
        : { ok: true }
    }
    const effective = name ?? (profiles.length === 1 ? profiles[0]!.name : undefined)
    if (effective === undefined) {
      const available = profiles.map((p) => p.name).join(', ')
      return { ok: false, status: 400, error: `profile is required (available: ${available})` }
    }
    const profile = profileFor(effective)
    if (!profile) return { ok: false, status: 400, error: `unknown profile: ${effective}` }
    if (allowedProfiles && !allowedProfiles.includes(profile.name)) {
      return { ok: false, status: 403, error: `profile not allowed: ${profile.name}` }
    }
    return { ok: true, profile }
  }

  // Notifications ride the registry hook rather than the create paths, because the
  // session that most needs to reach a phone may be one that parked and was
  // rebuilt — and that path never goes near `createRunner`.
  const notifier = new SessionNotifier(options.notifications ?? {})
  /** Models each claude profile's CLI last reported, so `GET /profiles` can offer
   * a create form a picker rather than a text box.
   *
   * Learned from sessions rather than probed: `supportedModels()` needs a live
   * CLI, and spawning one per profile to fill a dropdown is a poor trade when
   * any session that has ever run already answered the question. The cost is
   * that a server which has run nothing yet still offers a text field.
   */
  const profileModels = new Map<string, { models: ModelOption[]; defaultModel?: string }>()
  const registry = new SessionRegistry({
    onRegister: (runner) => {
      notifier.watch(runner)
      const profile = runner.info().profile
      if (!profile) return
      runner.subscribe((event) => {
        if (event.type !== 'capabilities' || event.models.length === 0) return
        profileModels.set(profile, { models: event.models, defaultModel: event.defaultModel })
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
    onError: options.parking?.onError,
    rebuild: (record) => buildRunner(record.config, record.snapshot),
    attachedCount: (sessionId) => bridge.attachedCount(sessionId),
    // Accounting is the queue's: it frees the run's slot and stops its clock, and
    // refuses the park outright when the run is already finalizing.
    onParking: (sessionId, executionId) => queue?.onSessionParking(sessionId, executionId) ?? true,
    onResumed: (sessionId, runner) => queue?.onSessionResumed(sessionId, runner),
  })
  const wss = new WebSocketServer({ noServer: true })
  /** Profiles (by name; '' = none) whose oauth notice has been logged. */
  const subscriptionNoticeShown = new Set<string>()

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
          const runner = await createRunner(config)
          watchAuthSource(runner)
          return runner
        },
        buildRunnerConfig,
        // A run that ends while parked (canceled, killed) leaves a snapshot behind
        // that nothing will ever wake.
        discardSession: (sessionId) => parking.discard(sessionId),
      })
    : undefined

  // Watch each session's init handshake for its auth provenance ('oauth' = claude.ai
  // subscription). The listener is a no-op after the first init; not worth unsubscribing.
  const watchAuthSource = (runner: Runner): void => {
    let seen = false
    runner.subscribe((event) => {
      if (seen || event.type !== 'system_init') return
      seen = true
      if (event.apiKeySource !== 'oauth') return
      if (options.requireApiKey) {
        runner.fail(
          'This server requires API-key auth (requireApiKey), but the session initialized ' +
            "with claude.ai subscription credentials (apiKeySource 'oauth'). Set " +
            'ANTHROPIC_API_KEY (or Bedrock/Vertex auth) in the server environment.',
        )
      } else {
        // Per profile, not global: distinct profiles are distinct accounts, and each
        // operator deserves the notice once.
        const profileName = runner.info().profile ?? ''
        if (subscriptionNoticeShown.has(profileName)) return
        subscriptionNoticeShown.add(profileName)
        const scope = profileName ? `Sessions under profile '${profileName}'` : 'Sessions'
        console.warn(
          `[workerdeck] ${scope} are using claude.ai subscription credentials ` +
            "(apiKeySource 'oauth'), not an API key. That is only appropriate for personal, " +
            'single-user use of your own account. Unattended/scheduled or multi-user use ' +
            "requires an API key under Anthropic's terms — set ANTHROPIC_API_KEY in the " +
            'server environment, or set requireApiKey: true to fail closed.',
        )
      }
    })
  }

  /**
   * Probe each Claude profile's credentials the way its sessions will actually
   * experience them: the env the real assembly path produces, so anything the
   * host hook injects (a CLAUDE_CODE_OAUTH_TOKEN, say) counts as logged in.
   * Provider profiles resolve credentials in the engine factory and are not
   * probed. Fire-and-forget by design — see the `checkCredentials` option doc.
   */
  const preflightCredentials = (): void => {
    if (!options.checkCredentials) return
    const conf = options.checkCredentials === true ? {} : options.checkCredentials
    const probe: ClaudeAuthProbe =
      conf.probe ?? ((env) => checkClaudeAuth(env, { timeoutMs: conf.timeoutMs }))
    for (const profile of allProfiles()) {
      if (isProviderProfile(profile)) continue
      let env: Record<string, string | undefined>
      try {
        env = buildRunnerConfig({ cwd: process.cwd(), profile: profile.name }).env ?? process.env
      } catch {
        // A host hook may choke on a probe-shaped request; fall back to the
        // profile pin alone, applied exactly as the real path applies it.
        env = claudeSessionEnv(profile, process.env)
      }
      void probe(env)
        .then((status) => {
          if (status !== 'logged_out') return
          console.warn(
            `[workerdeck] Profile '${profile.name}' (${profile.configDir}) has no usable ` +
              'Claude credentials: `claude auth status` reports logged out for the environment ' +
              'its sessions run with, so they will fail with "Not logged in". Log in under ' +
              `that dir (CLAUDE_CONFIG_DIR=${profile.configDir} claude auth login), inject a ` +
              'long-lived token via buildRunnerConfig (CLAUDE_CODE_OAUTH_TOKEN), or set ' +
              'ANTHROPIC_API_KEY. `checkCredentials: false` disables this check.',
          )
        })
        .catch(() => {
          // a probe that breaks is 'unknown', and unknown stays silent
        })
    }
  }

  type AuthContext = { ok: boolean; allowedProfiles?: string[]; canManageProfiles?: boolean }
  const authenticate = async (req: IncomingMessage): Promise<AuthContext> => {
    if (!options.authenticate) return { ok: true }
    const principal = await options.authenticate(req)
    if (principal === null || principal === undefined || principal === false) return { ok: false }
    const allowed = (principal as { allowedProfiles?: unknown }).allowedProfiles
    return {
      ok: true,
      allowedProfiles:
        Array.isArray(allowed) && allowed.every((p) => typeof p === 'string')
          ? (allowed as string[])
          : undefined,
      // Opt-in, and only ever true when the host says so: an unauthenticated dev
      // server (no `authenticate`) returns early above and manages nothing.
      canManageProfiles:
        (principal as { canManageProfiles?: unknown }).canManageProfiles === true,
    }
  }

  // Route pattern: {basePath}/sessions[/:id[/ws | /permissions/:requestId |
  //   /files[/<path>] | /attachments[/:attachmentId] | /mcp[/:serverName]]]
  const parseRoute = (
    url: string,
  ): {
    id?: string
    ws?: boolean
    permissionId?: string
    files?: boolean
    filePath?: string
    attachments?: boolean
    attachmentId?: string
    mcp?: boolean
    mcpServer?: string
  } | null => {
    const pathname = new URL(url, 'http://internal').pathname
    if (!pathname.startsWith(basePath + '/sessions')) return null
    const rest = pathname.slice((basePath + '/sessions').length)
    if (rest === '' || rest === '/') return {}
    const parts = rest.replace(/^\//, '').split('/')
    if (parts.length === 1) return { id: decodeURIComponent(parts[0]!) }
    if (parts.length === 2 && parts[1] === 'ws') {
      return { id: decodeURIComponent(parts[0]!), ws: true }
    }
    if (parts.length === 3 && parts[1] === 'permissions') {
      return { id: decodeURIComponent(parts[0]!), permissionId: decodeURIComponent(parts[2]!) }
    }
    if (parts.length <= 3 && parts[1] === 'attachments') {
      return {
        id: decodeURIComponent(parts[0]!),
        attachments: true,
        attachmentId: parts[2] === undefined ? undefined : decodeURIComponent(parts[2]),
      }
    }
    if (parts.length <= 3 && parts[1] === 'mcp') {
      // Server names are opaque and may contain ':' (plugin:gtm:gtm) — one segment,
      // decoded whole.
      return {
        id: decodeURIComponent(parts[0]!),
        mcp: true,
        mcpServer: parts[2] === undefined ? undefined : decodeURIComponent(parts[2]),
      }
    }
    if (parts.length >= 2 && parts[1] === 'files') {
      // The remainder is a VFS path — slashes are its separators, so segments
      // are decoded individually and rejoined.
      const filePath = parts.slice(2).map(decodeURIComponent).join('/')
      return {
        id: decodeURIComponent(parts[0]!),
        files: true,
        filePath: filePath === '' ? undefined : '/' + filePath,
      }
    }
    return null
  }

  // Host filesystem: built once at startup so a misdeclared root fails here rather
  // than on the first request from a phone. Null = the routes do not exist.
  //
  // Reading inherits the cwd policy — a caller who can start a session in a root
  // can already read it through the agent — so `hostFiles.roots` is a narrowing,
  // not the enabling grant. `??` and not `||`: an explicit `roots: []` is an
  // operator turning the routes off, which must not fall through to the cwd roots.
  const hostFileRootPaths = options.hostFiles?.roots ?? options.allowedCwdRoots
  const hostFiles = hostFileRootPaths?.length ? createHostFileRoots(hostFileRootPaths) : null
  const hostFilesWritable = options.hostFiles?.write === true
  const maxHostFileBytes = options.hostFiles?.maxFileBytes ?? 1024 * 1024
  const maxHostDirEntries = options.hostFiles?.maxEntries ?? 5000

  /**
   * `{basePath}/sessions/:id/attachments` — the files a client sends with a message.
   *
   * `POST ?name=<name>` takes the raw bytes as the body and the media type from
   * the `content-type` header; there is no multipart parsing here on purpose, so
   * a phone and a browser both upload with one plain request and this file stays
   * dependency-free. `GET /:attachmentId` hands the bytes back for thumbnails.
   *
   * The download always answers `content-disposition: attachment` and `nosniff`,
   * the same as `/files`: an upload is client-supplied content served from the
   * gateway's own origin, and it must never render as a document there. (An
   * `<img src>` is unaffected — disposition does not apply to subresources.)
   */
  const handleAttachments = async (
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    attachmentId?: string,
  ): Promise<void> => {
    if (req.method === 'POST' && attachmentId === undefined) {
      const url = new URL(req.url ?? '/', 'http://internal')
      const mediaType = req.headers['content-type']
      if (!mediaType) {
        json(res, 400, { error: 'content-type header is required' })
        return
      }
      let body: Buffer
      try {
        body = await readRawBody(req, attachmentStore.maxFileBytes)
      } catch {
        json(res, 413, { error: 'attachment is larger than the limit' })
        return
      }
      const result = attachmentStore.put(
        sessionId,
        url.searchParams.get('name') ?? 'attachment',
        mediaType,
        body,
      )
      if (!result.ok) {
        const status =
          result.error.code === 'unsupported_type'
            ? 415
            : result.error.code === 'empty'
              ? 400
              : 413
        json(res, status, { error: result.error.message })
        return
      }
      json(res, 201, { attachment: result.attachment })
      return
    }
    if (req.method === 'GET' && attachmentId !== undefined) {
      const found = attachmentStore.get(sessionId, attachmentId)
      if (!found) {
        json(res, 404, { error: 'attachment not found' })
        return
      }
      const bytes = Buffer.from(found.data, 'base64')
      res.writeHead(200, {
        'content-type': found.mediaType,
        'content-length': bytes.length,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }

  /**
   * `{basePath}/sessions/:id/mcp` — the session's MCP servers, and the three
   * things the CLI's own `/mcp` screen can do to one (reconnect, enable, disable).
   *
   * Every answer goes through `mcpStatusInfo`, which is where the servers' `env`
   * and `headers` are dropped: reading this route must not be a way to read the
   * operator's API tokens.
   */
  const handleMcp = async (
    req: IncomingMessage,
    res: ServerResponse,
    runner: Runner,
    serverName?: string,
  ): Promise<void> => {
    const listServers = async (): Promise<boolean> => {
      const servers = await runner.mcpServers?.()
      if (!servers) {
        json(res, 501, { error: 'this session does not report MCP servers' })
        return false
      }
      json(res, 200, { servers })
      return true
    }
    if (req.method === 'GET' && serverName === undefined) {
      await listServers()
      return
    }
    if (req.method === 'POST' && serverName !== undefined) {
      const body = (await readJsonBody(req, maxBodyBytes)) as McpServerActionRequest
      if (body?.action !== 'reconnect' && body?.action !== 'enable' && body?.action !== 'disable') {
        json(res, 400, { error: "action must be 'reconnect', 'enable' or 'disable'" })
        return
      }
      try {
        if (body.action === 'reconnect') await runner.reconnectMcpServer?.(serverName)
        else await runner.setMcpServerEnabled?.(serverName, body.action === 'enable')
      } catch (error) {
        // The CLI's own message ("No MCP server found named x") is the useful one.
        json(res, 400, { error: error instanceof Error ? error.message : 'MCP action failed' })
        return
      }
      await listServers()
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }

  /**
   * `{basePath}/fs/*` — the operator's real tree. Authorized by the auth key alone
   * and deliberately outside the agent permission flow: the caller is the operator.
   *
   * Every path in here goes through `host-files.ts` first, which canonicalizes and
   * *then* re-checks containment. The naive prefix compare `cwdAllowed` does would
   * be wrong at this door — the agent writes into these trees, and a symlink it
   * created is a path the operator never typed.
   */
  const handleHostFiles = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    if (!hostFiles) {
      json(res, 404, { error: 'host file access is not configured on this server' })
      return
    }
    const route = pathname.slice((basePath + '/fs/').length)
    const url = new URL(req.url ?? '/', 'http://internal')
    const requested = url.searchParams.get('path')

    if (route === 'roots') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      // The canonical spelling, not the operator's: every other route answers in
      // canonical paths, and a client that round-trips a root it was given must
      // land on the same tree.
      json(res, 200, {
        roots: hostFiles.roots.map(({ canonical }) => ({
          path: canonical,
          name: basename(canonical) || canonical,
        })),
        canWrite: hostFilesWritable,
      })
      return
    }

    if (route === 'find') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!requested) {
        json(res, 400, { error: 'path is required' })
        return
      }
      const resolved = resolveExisting(hostFiles, requested)
      if (!resolved.ok) {
        json(res, resolved.status, { error: resolved.error })
        return
      }
      if (resolved.kind !== 'dir') {
        json(res, 400, { error: 'not a directory' })
        return
      }
      // Clamped, not validated: this runs per keystroke from a phone, and a
      // client asking for 10,000 matches is a client that made a typo.
      const asked = Number(url.searchParams.get('limit') ?? '')
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 50
      const result = searchFiles(resolved.path, {
        query: url.searchParams.get('q') ?? '',
        limit,
        ignore: options.hostFiles?.ignore,
      })
      json(res, 200, { base: resolved.path, ...result })
      return
    }

    if (route === 'list' || route === 'read') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!requested) {
        json(res, 400, { error: 'path is required' })
        return
      }
      const resolved = resolveExisting(hostFiles, requested)
      if (!resolved.ok) {
        json(res, resolved.status, { error: resolved.error })
        return
      }
      if (route === 'list') {
        if (resolved.kind !== 'dir') {
          json(res, 400, { error: 'not a directory' })
          return
        }
        let names: Dirent[]
        try {
          names = readdirSync(resolved.path, { withFileTypes: true })
        } catch {
          json(res, 403, { error: 'directory is not readable' })
          return
        }
        const truncated = names.length > maxHostDirEntries
        const entries = names.slice(0, maxHostDirEntries).map((entry) => {
          const path = join(resolved.path, entry.name)
          const type = entryKind(entry)
          // Size/mtime for regular files only, and via lstat — a listing must
          // never stat *through* a link, or a directory holding a link to a fifo
          // becomes an unlistable directory.
          let bytes: number | undefined
          let modifiedAt: number | undefined
          if (type === 'file') {
            try {
              const s = lstatSync(path)
              bytes = s.size
              modifiedAt = s.mtimeMs
            } catch {
              // Raced with a delete, or unreadable — the entry still lists.
            }
          }
          return { name: entry.name, path, type, bytes, modifiedAt }
        })
        entries.sort((a, b) => {
          const rank = (t: string): number => (t === 'dir' ? 0 : 1)
          return rank(a.type) - rank(b.type) || a.name.localeCompare(b.name)
        })
        json(res, 200, { path: resolved.path, entries, ...(truncated ? { truncated } : {}) })
        return
      }

      if (resolved.kind !== 'file') {
        json(res, 400, { error: 'not a regular file' })
        return
      }
      // Cheap pre-check so a gigabyte is refused rather than buffered. Advisory
      // only — the authoritative cap is on the bytes actually read, since the
      // file can grow between the stat and the open.
      let modifiedAt = 0
      try {
        const stats = lstatSync(resolved.path)
        if (stats.size > maxHostFileBytes) {
          json(res, 413, { error: `file is larger than ${maxHostFileBytes} bytes` })
          return
        }
        modifiedAt = stats.mtimeMs
      } catch {
        json(res, 404, { error: 'not found' })
        return
      }
      // Opens the canonical path with O_NOFOLLOW and gates on fstat, so a
      // component swapped for a symlink or a fifo after the resolve is refused
      // rather than followed or blocked on.
      const read = readContained(resolved.path)
      if (!read.ok) {
        json(res, read.status, { error: read.error })
        return
      }
      if (read.data.length > maxHostFileBytes) {
        json(res, 413, { error: `file is larger than ${maxHostFileBytes} bytes` })
        return
      }
      const text = asUtf8(read.data)
      json(res, 200, {
        path: resolved.path,
        content: text ?? read.data.toString('base64'),
        encoding: text === null ? 'base64' : 'utf8',
        bytes: read.data.length,
        hash: hashBytes(read.data),
        modifiedAt,
      })
      return
    }

    if (route === 'write') {
      if (req.method !== 'PUT') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!hostFilesWritable) {
        json(res, 403, { error: 'host file writes are not enabled on this server' })
        return
      }
      const body = (await readJsonBody(req, maxBodyBytes)) as WriteHostFileRequest
      if (!body.path || typeof body.path !== 'string') {
        json(res, 400, { error: 'path is required' })
        return
      }
      if (typeof body.content !== 'string') {
        json(res, 400, { error: 'content is required' })
        return
      }
      if (body.encoding !== undefined && body.encoding !== 'utf8' && body.encoding !== 'base64') {
        json(res, 400, { error: "encoding must be 'utf8' or 'base64'" })
        return
      }
      const resolved = resolveForWrite(hostFiles, body.path)
      if (!resolved.ok) {
        json(res, resolved.status, { error: resolved.error })
        return
      }
      const next = Buffer.from(body.content, body.encoding ?? 'utf8')
      if (next.length > maxHostFileBytes) {
        json(res, 413, { error: `content is larger than ${maxHostFileBytes} bytes` })
        return
      }
      // The agent is editing this same tree. Every write is conditional: either it
      // creates a file that does not exist, or it names the hash it is replacing.
      // There is no unconditional overwrite to reach for from a phone.
      //
      // Existence is decided by the read, not by a stat: `readContained` answers
      // 404 only for ENOENT, so anything else — an unreadable file, a swapped-in
      // device — refuses here instead of being mistaken for "not there yet" and
      // then clobbered as a create.
      const current = readContained(resolved.path)
      if (!current.ok && current.status !== 404) {
        json(res, current.status, { error: current.error })
        return
      }
      const existing = current.ok ? current.data : null
      if (existing && !body.expectedHash) {
        json(res, 409, { error: 'file exists — pass expectedHash to overwrite it' })
        return
      }
      if (existing && hashBytes(existing) !== body.expectedHash) {
        json(res, 409, { error: 'file changed on disk since it was read' })
        return
      }
      if (!existing && body.expectedHash) {
        json(res, 409, { error: 'file no longer exists' })
        return
      }
      const written = writeContained(resolved.path, next)
      if (!written.ok) {
        json(res, written.status, { error: written.error })
        return
      }
      let writtenAt = 0
      try {
        writtenAt = lstatSync(resolved.path).mtimeMs
      } catch {
        // The write landed; a stat that loses a race with a delete is not a
        // reason to report failure.
      }
      json(res, 200, {
        path: resolved.path,
        bytes: next.length,
        hash: hashBytes(next),
        modifiedAt: writtenAt,
      })
      return
    }

    json(res, 404, { error: 'not found' })
  }

  const listSdkSessions = options.listSdkSessions ?? defaultSdkSessionLister

  const handleSdkSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://internal')
    const dir = url.searchParams.get('dir') ?? undefined
    const roots = options.allowedCwdRoots
    const limit = Number(url.searchParams.get('limit') ?? '') || undefined
    const offset = Number(url.searchParams.get('offset') ?? '') || undefined
    if (roots && roots.length > 0) {
      if (dir) {
        if (!cwdAllowed(dir, roots)) {
          json(res, 403, { error: 'dir is outside the allowed roots' })
          return
        }
      } else {
        // A bare listing spans ALL projects on the host, which is wider than the
        // cwd policy. Rather than refuse — a client with no directory to name (the
        // iOS session list) has no other way to ask — list them and drop the ones
        // outside the roots.
        //
        // Filtering, not fanning out over the roots: `dir` selects one project
        // directory and its worktrees, not everything beneath it, so asking for
        // `/Users/me/projects` finds nothing when the sessions belong to
        // `/Users/me/projects/some-app`. Pagination is applied after the filter for
        // the same reason, which is why the underlying call takes neither bound.
        json(res, 200, { sdkSessions: withinRoots(await listSdkSessions({}), roots, limit, offset) })
        return
      }
    }
    json(res, 200, { sdkSessions: await listSdkSessions({ dir, limit, offset }) })
  }

  /** The sessions whose `cwd` is inside the roots, newest first, then paged. A
   * summary with no `cwd` cannot be shown to be inside them, so it is dropped. */
  const withinRoots = (
    sessions: SdkSessionSummary[],
    roots: string[],
    limit?: number,
    offset = 0,
  ): SdkSessionSummary[] => {
    const allowed = sessions
      .filter((s) => s.cwd !== undefined && cwdAllowed(s.cwd, roots))
      .sort((a, b) => b.lastModified - a.lastModified)
    return limit === undefined ? allowed.slice(offset) : allowed.slice(offset, offset + limit)
  }

  const handleJobs = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    auth: AuthContext,
  ): Promise<void> => {
    if (!queue) {
      json(res, 404, { error: 'job queue not configured' })
      return
    }
    if (pathname === basePath + '/queue') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      json(res, 200, { stats: await queue.stats() })
      return
    }
    const rest = pathname.slice((basePath + '/jobs').length).replace(/^\//, '')
    if (rest === '') {
      if (req.method === 'GET') {
        json(res, 200, { jobs: await queue.list() })
        return
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req, maxBodyBytes)) as CreateJobRequest
        if (!body.session || typeof body.session !== 'object') {
          json(res, 400, { error: 'session is required' })
          return
        }
        if (!body.session.cwd || typeof body.session.cwd !== 'string') {
          json(res, 400, { error: 'session.cwd is required' })
          return
        }
        if (!body.session.prompt || typeof body.session.prompt !== 'string') {
          json(res, 400, { error: 'session.prompt is required' })
          return
        }
        if (!cwdAllowed(body.session.cwd, options.allowedCwdRoots)) {
          json(res, 403, { error: 'cwd is outside the allowed roots' })
          return
        }
        const refused = applyBypassPolicy(body.session)
        if (refused) {
          json(res, 403, { error: refused })
          return
        }
        const resolved = resolveProfile(body.session.profile, auth.allowedProfiles)
        if (!resolved.ok) {
          json(res, resolved.status, { error: resolved.error })
          return
        }
        const badRequest =
          checkPermissionMode(body.session.permissionMode, resolved.profile) ??
          checkEngineGrants(body.session, resolved.profile)
        if (badRequest) {
          json(res, 400, { error: badRequest })
          return
        }
        // Normalize to the resolved name so an implicit single profile still lands
        // on JobInfo.profile and reaches the runner config at claim time.
        body.session.profile = resolved.profile?.name
        try {
          json(res, 201, { job: await queue.submit(body) })
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : 'invalid job' })
        }
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const id = decodeURIComponent(rest)
    if (id.includes('/')) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (req.method === 'GET') {
      const job = await queue.get(id)
      if (job) json(res, 200, { job })
      else json(res, 404, { error: 'job not found' })
      return
    }
    if (req.method === 'DELETE') {
      const job = await queue.cancel(id)
      if (job) json(res, 200, { job })
      else json(res, 404, { error: 'job not found' })
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }

  /**
   * `POST {basePath}/executions/:executionId/result` — a deferred executor
   * delivering its outcome. Wakes the parked session, applies the result to its
   * agent loop, and lets the run continue.
   *
   * Scoped like every other session route: a principal restricted to certain
   * profiles cannot settle an execution belonging to a session outside them —
   * a result is trusted tool input, and injecting one into another tenant's loop
   * would be a way to steer it.
   */
  const handleExecutionResult = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    auth: AuthContext,
  ): Promise<void> => {
    const rest = pathname.slice((basePath + '/executions/').length).split('/')
    if (rest.length !== 2 || rest[1] !== 'result' || !rest[0]) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const executionId = decodeURIComponent(rest[0])
    const body = (await readJsonBody(req, maxBodyBytes)) as SubmitExecutionResultRequest
    let result: ToolExecutionResult
    if (body?.status === 'ok') {
      if (!body.output || typeof body.output !== 'object') {
        json(res, 400, { error: "output is required for status 'ok'" })
        return
      }
      result = { status: 'ok', output: body.output.value, logs: body.logs }
    } else if (body?.status === 'failed') {
      if (typeof body.reason !== 'string' || typeof body.error !== 'string') {
        json(res, 400, { error: "reason and error are required for status 'failed'" })
        return
      }
      result = { status: 'failed', reason: body.reason, error: body.error, logs: body.logs }
    } else {
      json(res, 400, { error: "status must be 'ok' or 'failed'" })
      return
    }
    if (auth.allowedProfiles) {
      const owner = parking.sessionFor(executionId)
      const profile =
        owner === undefined
          ? undefined
          : (registry.get(owner)?.info().profile ?? (await parking.get(owner))?.profile)
      // Indistinguishable from an unknown id on purpose: whether an execution
      // exists elsewhere is not this caller's business.
      if (owner === undefined || (profile !== undefined && !auth.allowedProfiles.includes(profile))) {
        json(res, 404, { error: 'execution not found' })
        return
      }
    }
    const applied = await parking.submitResult(executionId, result)
    if (!applied) {
      json(res, 404, { error: 'execution not found (unknown id, or its session has ended)' })
      return
    }
    json(res, 200, applied)
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname
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
      const auth = await authenticate(req)
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleJobs(req, res, pathname, auth)
      return
    }
    if (pathname === basePath + '/profiles' || pathname.startsWith(basePath + '/profiles/')) {
      const auth = await authenticate(req)
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      const rest = pathname.slice((basePath + '/profiles').length).replace(/^\//, '')
      if (rest === '') {
        if (req.method === 'GET') {
          const visible = auth.allowedProfiles
            ? allProfiles().filter((p) => auth.allowedProfiles!.includes(p.name))
            : allProfiles()
          json(res, 200, {
            profiles: visible.map(forResponse),
            canManage: manageGuard(auth) === null,
          })
          return
        }
        if (req.method === 'POST') {
          const refused = manageGuard(auth)
          if (refused) {
            json(res, refused.status, { error: refused.error })
            return
          }
          const body = (await readJsonBody(req, maxBodyBytes)) as ProfileInfo
          if (!body.name || typeof body.name !== 'string') {
            json(res, 400, { error: 'name is required' })
            return
          }
          if (profileFor(body.name)) {
            json(res, 409, { error: `profile already exists: ${body.name}` })
            return
          }
          await saveManagedProfile(res, body)
          return
        }
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const name = decodeURIComponent(rest)
      const profile = name.includes('/') ? undefined : profileFor(name)
      if (!profile) {
        json(res, 404, { error: 'profile not found' })
        return
      }
      if (auth.allowedProfiles && !auth.allowedProfiles.includes(profile.name)) {
        json(res, 403, { error: `profile not allowed: ${profile.name}` })
        return
      }
      if (req.method === 'GET') {
        json(res, 200, { profile: withManagedFlag(profile), config: readProfileConfig(profile) })
        return
      }
      if (req.method === 'PATCH' || req.method === 'DELETE') {
        const refused = manageGuard(auth) ?? declaredGuard(profile)
        if (refused) {
          json(res, refused.status, { error: refused.error })
          return
        }
        if (req.method === 'DELETE') {
          await options.profileStore!.delete(profile.name)
          await refreshStored()
          res.writeHead(204).end()
          return
        }
        const patch = (await readJsonBody(req, maxBodyBytes)) as UpdateProfileRequest
        // `name` is the route, not the body — a rename would orphan every session
        // and job already pinned to the old one.
        await saveManagedProfile(res, { ...profile, ...patch, name: profile.name })
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (pathname.startsWith(basePath + '/executions/')) {
      const auth = await authenticate(req)
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleExecutionResult(req, res, pathname, auth)
      return
    }
    if (pathname === basePath + '/sdk-sessions') {
      if (!(await authenticate(req)).ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleSdkSessions(req, res)
      return
    }
    if (pathname.startsWith(basePath + '/fs/')) {
      // Authenticated before the 404-when-unconfigured answer, so an unauthenticated
      // caller cannot learn whether this server exposes a filesystem at all.
      if (!(await authenticate(req)).ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleHostFiles(req, res, pathname)
      return
    }
    const route = parseRoute(req.url ?? '/')
    if (!route || route.ws) {
      json(res, 404, { error: 'not found' })
      return
    }
    const auth = await authenticate(req)
    if (!auth.ok) {
      json(res, 401, { error: 'unauthorized' })
      return
    }

    if (!route.id) {
      if (req.method === 'GET') {
        // Parked sessions are live sessions that happen to have no runner right
        // now — leaving them out would read as "gone".
        json(res, 200, { sessions: [...registry.list(), ...(await parking.listInfo())] })
        return
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req, maxBodyBytes)) as CreateSessionRequest
        if (!body.cwd || typeof body.cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return
        }
        if (!cwdAllowed(body.cwd, options.allowedCwdRoots)) {
          json(res, 403, { error: 'cwd is outside the allowed roots' })
          return
        }
        const refused = applyBypassPolicy(body)
        if (refused) {
          json(res, 403, { error: refused })
          return
        }
        const resolved = resolveProfile(body.profile, auth.allowedProfiles)
        if (!resolved.ok) {
          json(res, resolved.status, { error: resolved.error })
          return
        }
        const badRequest =
          checkPermissionMode(body.permissionMode, resolved.profile) ??
          checkEngineGrants(body, resolved.profile)
        if (badRequest) {
          json(res, 400, { error: badRequest })
          return
        }
        // Resolved name (even when implicit) so SessionInfo.profile is always set.
        body.profile = resolved.profile?.name
        const runner = await createRunner(buildRunnerConfig(body))
        watchAuthSource(runner)
        json(res, 201, { session: runner.info() })
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }

    const runner = registry.get(route.id)
    // A parked session has no runner but is very much alive: it reads, lists, and
    // serves its files from the snapshot, and only waking it needs a rebuild.
    const parked = runner ? null : await parking.get(route.id)
    if (!runner && !parked) {
      json(res, 404, { error: 'session not found' })
      return
    }
    if (route.attachments) {
      await handleAttachments(req, res, route.id, route.attachmentId)
      return
    }
    if (route.mcp) {
      if (!runner) {
        json(res, 409, { error: 'session is parked (wake it before asking about MCP)' })
        return
      }
      await handleMcp(req, res, runner, route.mcpServer)
      return
    }
    if (route.files) {
      // Deliverables live in the session's in-memory VFS — downloadable while
      // the session lives (durability is a persistence-tier concern, not ours).
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const snapshotFiles = parked?.snapshot.vfs
      const vfs = runner?.vfs ?? (snapshotFiles && {
        list: () => Object.keys(snapshotFiles).sort(),
        read: (path: string) => snapshotFiles[path],
      })
      if (!vfs) {
        json(res, 404, { error: 'session has no file store' })
        return
      }
      if (route.filePath === undefined) {
        const files = vfs.list().map((path) => ({ path, bytes: vfs.read(path)?.length ?? 0 }))
        json(res, 200, { files })
        return
      }
      const content = vfs.read(route.filePath)
      if (content === undefined) {
        json(res, 404, { error: `no such file: ${route.filePath}` })
        return
      }
      const filename = route.filePath.split('/').pop() || 'file'
      res.writeHead(200, {
        'content-type': contentTypeFor(filename),
        'content-length': Buffer.byteLength(content),
        // RFC 5987 filename* so non-ASCII names survive; plain filename for the rest.
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        // Agent-authored content must never render on this origin.
        'x-content-type-options': 'nosniff',
      })
      res.end(content)
      return
    }
    if (route.permissionId) {
      // REST counterpart of the WS permission_decision command, for controllers
      // without a socket (e.g. answering a job's AskUserQuestion from a webhook).
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const body = (await readJsonBody(req, maxBodyBytes)) as ResolvePermissionRequest
      if (body?.behavior !== 'allow' && body?.behavior !== 'deny') {
        json(res, 400, { error: "behavior must be 'allow' or 'deny'" })
        return
      }
      if (!runner) {
        json(res, 409, { error: 'session is parked (it has no pending permission requests)' })
        return
      }
      if (!runner.resolvePermission(route.permissionId, body)) {
        json(res, 404, { error: 'permission request not found (already resolved or expired)' })
        return
      }
      json(res, 200, { resolved: true })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { session: runner?.info() ?? parked!.info })
      return
    }
    if (req.method === 'DELETE') {
      registry.remove(route.id)
      // Fail anything still bridged: the session is gone, so no answer can land.
      bridge.remove(route.id)
      // And drop any parked state, so a late execution result can't wake a session
      // the client just ended.
      await parking.discard(route.id)
      // The session is gone; so is anything it was holding for it.
      attachmentStore.drop(route.id)
      json(res, 200, {
        session: runner?.info() ?? { ...parked!.info, status: 'closed' as const },
      })
      return
    }
    json(res, 405, { error: 'method not allowed' })
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
        if (!(await authenticate(req)).ok) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
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
      const route = parseRoute(req.url ?? '/')
      if (!route?.ws || !route.id) {
        socket.destroy()
        return
      }
      if (!(await authenticate(req)).ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      // Attaching to a parked session wakes it: the client wants to drive it, and
      // its whole event log comes back with it, so `afterSeq` still lines up.
      const runner = await parking.ensureLive(route.id).catch(() => undefined)
      if (!runner) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachClient(ws, runner, req)
      })
    })().catch(() => socket.destroy())
  })

  const attachClient = (ws: WebSocket, runner: Runner, req: IncomingMessage): void => {
    const url = new URL(req.url ?? '/', 'http://internal')
    const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0

    const send = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    send({
      type: 'attached',
      protocolVersion: PROTOCOL_VERSION,
      session: runner.info(),
      replayingFrom: afterSeq,
    })
    const unsubscribe = runner.subscribe((event) => send({ type: 'event', event }), afterSeq)
    // Register for bridged tool calls: this client can be asked to execute them
    // in its own sandbox (see BridgeHub).
    const detachBridge = bridge.attach(runner.id, send)

    ws.on('message', (data: Buffer) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(data.toString('utf8')) as ClientFrame
      } catch {
        send({ type: 'protocol_error', message: 'invalid JSON frame' })
        return
      }
      handleCommand(frame, runner).catch((error: unknown) => {
        send({
          type: 'protocol_error',
          message: error instanceof Error ? error.message : 'command failed',
        })
      })
    })
    ws.on('close', () => {
      unsubscribe()
      detachBridge()
      // Nobody watching any more: a session waiting on a deferred execution can
      // give its runner back (after a grace period, so a reconnect costs nothing).
      parking.onDetach(runner.id)
    })
  }

  const handleCommand = async (frame: ClientFrame, runner: Runner): Promise<void> => {
    switch (frame.type) {
      case 'user_message': {
        if (!frame.attachmentIds?.length) {
          runner.sendMessage(frame.text)
          return
        }
        // The bytes live server-side; this is where a reference becomes content.
        // A missing id throws rather than sending a message that lost its picture.
        const resolved = attachmentStore.resolve(runner.id, frame.attachmentIds)
        if (!resolved.ok) {
          throw new Error(`unknown attachment(s): ${resolved.missing.join(', ')}`)
        }
        runner.sendMessage(frame.text, resolved.attachments)
        return
      }
      case 'permission_decision':
        if (frame.behavior === 'allow') {
          runner.resolvePermission(frame.requestId, {
            behavior: 'allow',
            updatedInput: frame.updatedInput,
          })
        } else {
          runner.resolvePermission(frame.requestId, {
            behavior: 'deny',
            message: frame.message,
            interrupt: frame.interrupt,
          })
        }
        return
      case 'interrupt':
        await runner.interrupt()
        return
      case 'set_permission_mode':
        if (frame.mode === 'bypassPermissions' && options.disableBypassPermissions) {
          throw new Error('bypassPermissions is disabled on this server (disableBypassPermissions)')
        }
        await runner.setPermissionMode(frame.mode)
        return
      case 'set_model':
        await runner.setModel(frame.model)
        return
      case 'tool_call_result':
        // Untrusted client input by contract — fine for the user's own data,
        // never a source for server-authoritative state. Unknown or already
        // settled ids are ignored rather than erroring: a late answer racing a
        // timeout is expected, not a client bug.
        bridge.resolve(runner.id, frame.executionId, { output: frame.output, logs: frame.logs })
        return
      case 'tool_call_error':
        bridge.resolve(runner.id, frame.executionId, {
          reason: frame.reason,
          error: frame.error,
          logs: frame.logs,
        })
        return
      case 'close':
        runner.close('client')
        return
      default:
        throw new Error(`unknown command: ${(frame as { type?: string }).type}`)
    }
  }

  return {
    server,
    registry,
    queue,
    bridge,
    parking,
    listen: async (port, host) => {
      // Before the first request: every lookup on the request path reads the
      // in-memory mirror, so it has to be populated before anything can hit it.
      await refreshStored()
      // Re-index and re-arm anything a durable store carried across a restart.
      await parking.hydrate()
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          // After the bind and after refreshStored(), so stored profiles are
          // probed too; advisory, so it must never delay or wedge the listen.
          preflightCredentials()
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
