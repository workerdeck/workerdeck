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
 * Return a principal (any truthy value) to accept the request, null/undefined to reject with 401.
 *
 * **This is the place to be expensive** — it is async and runs once per request, unlike the
 * synchronous per-row {@link WorkerServerOptions.authorizeSession}. A principal may carry
 * `allowedProfiles: string[]`, `canManageProfiles: true`, `operator: boolean` and
 * `scope: Record<string, string>`; see `docs/GOTCHAS.md` §Session scope and §Server, profiles & auth.
 */
export type Authenticator = (req: IncomingMessage) => unknown | Promise<unknown>

export type WorkerServerOptions = {
  /** Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. */
  authenticate?: Authenticator
  /** Explicit opt-in to run without auth (local dev only). */
  allowUnauthenticated?: boolean
  /**
   * Whether a principal may see — and therefore fully drive — one session; the policy half of
   * {@link CreateSessionRequest.scope}. **Synchronous on purpose** (it runs per route and per row
   * of every list), false means 404 rather than 403, a throw reads as false, and declaring it at
   * all withdraws the unscoped-means-operator default. See `docs/GOTCHAS.md` §Session scope.
   */
  authorizeSession?: (principal: unknown, session: SessionInfo) => boolean
  /** If set, session cwd must resolve inside one of these roots. Strongly recommended. */
  allowedCwdRoots?: string[]
  /**
   * The host filesystem routes (`{basePath}/fs/*`) — operator-privileged browse/read of the real
   * project tree, with writing as its own opt-in. Reading follows {@link allowedCwdRoots} and
   * `roots` only *narrows* it; containment is `host-files.ts`' realpath check, never `cwdAllowed`.
   * See `docs/GOTCHAS.md` §Host filesystem.
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
   * Handle requests that fall outside `basePath` instead of 404ing them — how the turnkey CLI
   * serves the dashboard from the API's own origin, which is what makes a cookie-authenticated
   * WebSocket attach possible at all (`docs/GOTCHAS.md` §Server, profiles & auth). Anything
   * reached here gets no `authenticate` call, and upgrades are never routed here.
   */
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  /**
   * Browser origins allowed to call this API cross-origin — sharing policy, never a credential
   * (every real request still goes through `authenticate`). Two rules the implementation must
   * keep: **exact origins only**, and `Access-Control-Allow-Credentials` is **never** sent.
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
   * Probe each profile's real session env for a login at `listen()` and on a TTL, feeding
   * `ProfileInfo.available`. **Warn, never fail**, and silent on "couldn't check" — that is not
   * "not logged in". Off by default (a library must spawn nothing); pass an object to inject the
   * probe or a timeout. See `docs/GOTCHAS.md` §Server, profiles & auth.
   */
  checkCredentials?: boolean | { probe?: ClaudeAuthProbe; timeoutMs?: number }
  /**
   * Refuse create/submit on a profile the probe reported **definitely** unavailable (503 with the
   * probe's reason). Requires `checkCredentials`; 'unknown' always passes. Off by default —
   * display-only is right for an operator's own gateway, this is the trade for a deployment with
   * an end user in front of it. See `docs/PACKAGES.md` §`packages/server`.
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
   * The four human-attention moments (permission requested, turn done, error, closed) POSTed to a
   * webhook and/or handed to a local observer. Server-wide and covering every registry session,
   * unlike the queue's per-job webhook — and transport-agnostic on purpose: this server holds no
   * push credentials, so turning one into an APNs push is the CLI forwarder's job.
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
     * Keep live `provider` sessions written through to the store after each turn — the restart
     * story for the one engine dormancy cannot cover. **Off by default**: this writes a session's
     * whole transcript to `store`, and a library must not start doing that because someone
     * upgraded. See `docs/GOTCHAS.md` §Parking & bridged execution.
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
   * Kept as a host hook so this package neither imports a model SDK nor decides how provider
   * credentials are resolved; `claude` and `codex` go through core's adapters instead. May be
   * async — a rejection fails the create (500 on the session POST, `failed` for a job).
   * `createProviderRunner` is the 80% case.
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
