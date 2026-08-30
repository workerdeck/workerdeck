/**
 * The public option/result types of `createWorkerServer` — everything a host
 * configures, in one place. The assembly lives in `server.ts`; the per-route
 * behaviour in `routes/`; the stateful pieces in `services/`.
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ClaudeAuthProbe, EngineAdapter, Runner, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { JobQueue, QueueAdapter } from '@workerdeck/queue'
import type { CreateSessionRequest, JobEvent, ProfileEngine, ProfileInfo, SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import type { BridgeHub, BridgeHubOptions } from './services/bridge.ts'
import type { SessionNotificationOptions } from './services/notifications.ts'
import type { SessionParkManager } from './services/parking.ts'
import type { ProfileStore } from './services/profile-store.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { SessionStore } from './services/session-store.ts'

export type SdkSessionLister = (options: { dir?: string; limit?: number; offset?: number }) => Promise<SdkSessionSummary[]>

/**
 * Return a principal (any truthy value) to accept the request, or null/undefined to
 * reject with 401. The host app supplies this — the worker has no auth story of its
 * own. A principal object may carry `allowedProfiles: string[]` to restrict which
 * profiles the caller can create sessions/jobs under (and see in GET /profiles) —
 * without it the caller may use every declared profile. It may also carry
 * `canManageProfiles: true` to allow creating/editing/deleting managed profiles
 * (requires the `profileStore` option); anything else means no.
 *
 * It may also carry `scope: Record<string, string>` — the opaque tags deciding
 * which *sessions* this caller may see at all (see
 * {@link WorkerServerOptions.authorizeSession}). A principal carrying a scope is
 * an embedded end user rather than the operator, and is refused the
 * operator-privileged surfaces outright: `/fs/*`, `/sdk-sessions`, `/queue` and
 * `/queue/ws`.
 *
 * **This is the place to be expensive.** It is already async and already runs
 * once per request, so a lookup (which spaces is this user in?) belongs here,
 * landing its answer on the principal. The visibility check itself is
 * synchronous by design: it runs on every route and every row of every list.
 */
export type Authenticator = (req: IncomingMessage) => unknown | Promise<unknown>

export type WorkerServerOptions = {
  /** Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. */
  authenticate?: Authenticator
  /** Explicit opt-in to run without auth (local dev only). */
  allowUnauthenticated?: boolean
  /**
   * Whether a principal may see one session — the policy half of
   * {@link CreateSessionRequest.scope}. WorkerDeck stores the opaque tags and
   * enforces the answer at every door; what the tags *mean* is the host's, and
   * has to be, because "space" and "user" are one app's vocabulary and the next
   * embedder has tenants or projects or nothing.
   *
   * **Synchronous, deliberately.** It runs per route and per row of every list,
   * so resolving it against a database per request is the failure mode this
   * signature designs out: do the lookup in {@link Authenticator} and put the
   * answer on the principal.
   *
   * Unset, the default rule applies: every key the principal's `scope` pins must
   * equal the session's, and a principal with no scope (`undefined` or `{}`) is
   * unrestricted — the same "unset means all" rule `allowedProfiles` uses, so an
   * operator's dashboard is unaffected. A consequence worth stating: a session
   * carrying *no* scope is invisible to a scoped principal, which is the right
   * fail direction — sessions predating this feature never leak into an
   * end user's list.
   *
   * **False means the session does not exist**: every refusal answers 404, never
   * 403, matching `host-files.ts`' uniform-disclosure discipline. A predicate
   * that *throws* has not said yes — it is caught and read as false, so one
   * surprising row cannot turn a hundred-row list into a page-wide error.
   *
   * **Declaring this withdraws the unscoped-means-operator default.** The
   * gateway-wide surfaces (`/fs/*`, `/sdk-sessions`, `/queue`, `/queue/ws`) key
   * on {@link Authenticator}'s principal carrying no `scope` — but a host may
   * well write this predicate over its own principal shape and never set one,
   * and reading that as "everyone is the operator" would serve the host
   * filesystem to every end user whose sessions this correctly walls off. So
   * with a policy declared, operator principals must say `operator: true`.
   *
   * **True means full control, not read access.** An attach can send
   * `user_message`, `permission_decision`, `interrupt` and `close`, and a
   * bridged client can settle a tool call — so this is one boolean over "may
   * drive this session", not a visibility level. A read-only-for-my-team policy
   * is not expressible here yet; do not approximate it with `readOnly`, which is
   * affordance removal in a client and not an authorization boundary.
   */
  authorizeSession?: (principal: unknown, session: SessionInfo) => boolean
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
  /**
   * Browser origins allowed to call this API cross-origin — for a dashboard
   * served somewhere other than this gateway.
   *
   * Off unless configured, and even then it is *sharing policy, not a
   * credential*: preflights are answered before auth (browsers strip
   * credentials from them, so they would otherwise 401), but every real request
   * still goes through `authenticate`, and an allowlisted page that does not
   * hold the key gets nothing.
   *
   * Two rules the implementation must keep: **exact origins only**, no
   * wildcards or suffix matching; and `Access-Control-Allow-Credentials` is
   * **never** sent, which is what keeps an ambient cookie from becoming
   * cross-origin authority. WebSocket upgrades are exempt from CORS entirely
   * and are unaffected by this — their credential is whatever the host's
   * `authenticate` accepts on the handshake.
   */
  cors?: { origins: string[] }
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
  /**
   * Refuse to create a session or submit a job on a profile the credential
   * probe has reported **unavailable** — 503 with the probe's own reason —
   * rather than letting the run start and die mid-turn on a raw provider error.
   *
   * Off by default, and that default is right for an operator's own gateway:
   * the verdict can be stale in both directions, the operator may be three
   * seconds from finishing a login, and turning a probe bug into an outage is
   * worse than one confusing failure. It is wrong in front of an **end user**,
   * who cannot read a provider stack trace and did not choose the deployment's
   * credentials — which is why every embedder otherwise grows its own
   * `available` flag in front of the create button.
   *
   * Requires `checkCredentials`; without probes nothing is ever unavailable.
   * A profile whose verdict is 'unknown' (never probed, probe couldn't run) is
   * always allowed through — "couldn't check" is not "not available".
   */
  requireAvailableProfile?: boolean
  /** Injectable lister for GET /sdk-sessions (tests) — honored for the CLAUDE
   * engine only, like the injectable claude auth probe (it predates the adapter
   * layer). Defaults to the claude adapter's lister (the SDK's on-disk session
   * store); other engines always answer through their adapter's
   * `listSessions`. */
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
    /**
     * Keep live `provider` sessions written through to the store after each
     * turn, so they survive a gateway restart. **Off by default** — this writes
     * a session's whole transcript to `store` and a library must not start doing
     * that because someone upgraded.
     *
     * It is the restart story for the one engine dormancy cannot cover: claude
     * and codex are remembered by *engine session id* and resumed from their own
     * on-disk store, which a provider session does not have. Pair it with a
     * durable `store` — with the default in-memory one it does nothing a park
     * did not already do.
     *
     * The record is rebuilt lazily, on first attach, exactly like a dormant one;
     * a boot with fifty remembered sessions spawns nothing.
     */
    persistLive?: boolean
    /** Park/remember/resume failures — storage or engine-assembly problems, not
     * session errors. 'remember' is the write that lets a live session survive a
     * restart; losing one costs that session its way back and nothing else. */
    onError?: (error: unknown, context: { sessionId: string; phase: 'park' | 'remember' | 'resume' }) => void
  }
  /**
   * Build a runner for a `provider` profile (the model-agnostic engine).
   * Required if any such profile is declared — the server refuses to start
   * otherwise, rather than failing at create time.
   *
   * Kept as a host hook so the server package neither imports a model SDK nor
   * decides how provider credentials are resolved: the factory reads them from
   * the operator's environment, exactly like the Claude credential chain.
   * `claude` and `codex` profiles never come through here — those engines ship
   * as in-repo adapters (`@workerdeck/core`'s `getEngineAdapter`).
   *
   * May be async: assembly that has to await — a per-session MCP connect, a
   * credential lookup — belongs here, with `AiSdkRunnerConfig.onClose` as the
   * disposer. A rejection fails the create — the session POST answers 500 with
   * the message, a job goes straight to `failed`.
   */
  createEngineRunner?: (context: EngineRunnerContext) => Runner | Promise<Runner>
  /**
   * Adapter overrides, keyed by engine — **for tests only** (the server
   * integration suite injects a fake codex engine so `pnpm test` spawns no
   * binary). Not a public extension point: third engines belong in core as
   * adapters, or behind `createEngineRunner` as provider profiles.
   */
  engines?: Partial<Record<ProfileEngine, EngineAdapter>>
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
  /**
   * Set when rehydrating a session across a gateway restart: build the runner
   * under exactly this id rather than a fresh one. Never set together with
   * `restore` (a snapshot carries its own id). Ignoring it strands every
   * client's watermarks and routes, and the rebuild is refused.
   */
  id?: string
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
