import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ClaudeAuthProbe, EngineAdapter, Runner, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { JobQueue, QueueAdapter } from '@workerdeck/queue'
import type {
  CreateSessionRequest,
  JobEvent,
  ModelRate,
  ProfileEngine,
  ProfileInfo,
  SdkSessionSummary,
  SessionInfo,
} from '@workerdeck/protocol'
import type { BridgeHub, BridgeHubOptions } from './services/bridge.ts'
import type { SessionNotificationOptions } from './services/notifications.ts'
import type { ParkErrorContext, SessionParkManager } from './services/parking.ts'
import type { PeerServiceOptions } from './services/peers.ts'
import type { ProfileStore } from './services/profile-store.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { SessionStore } from './services/session-store.ts'
import type { SpendStore } from './services/spend-ledger.ts'

export type SdkSessionLister = (options: { dir?: string; limit?: number; offset?: number }) => Promise<SdkSessionSummary[]>

export type Authenticator = (req: IncomingMessage) => unknown | Promise<unknown>

export type WorkerServerOptions = {
  authenticate?: Authenticator
  allowUnauthenticated?: boolean
  authorizeSession?: (principal: unknown, session: SessionInfo) => boolean
  allowedCwdRoots?: string[]
  hostFiles?: {
    roots?: string[]
    write?: boolean
    maxFileBytes?: number
    maxEntries?: number
    ignore?: string[]
  }
  // `!` shell mode: the command runs on the host in the session's cwd and its output lands in the transcript and
  // the model's context. It goes through NO permission flow - no permission card, no allowlist, no
  // disableBypassPermissions - hence its own switch, default off, offered to operators only (never a scoped
  // principal) on engines with a host cwd. Defaults: 120s wall clock, 32 KiB of captured output.
  shell?: {
    enabled?: boolean
    timeoutMs?: number
    maxOutputBytes?: number
  }
  attachments?: {
    maxFileBytes?: number
    maxSessionBytes?: number
  }
  profiles?: ProfileInfo[]
  profileStore?: ProfileStore
  allowedConfigDirRoots?: string[]
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  basePath?: string
  fallback?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  cors?: { origins: string[] }
  maxBodyBytes?: number
  disableBypassPermissions?: boolean
  // How long a permission prompt or an AskUserQuestion may sit unanswered before the engine denies it.
  // Omitted or null: never - a prompt waits for a human for as long as the session lives. A session may
  // override it per request with CreateSessionRequest.approvalTimeoutMs.
  approvalTimeoutMs?: number | null
  requireApiKey?: boolean
  checkCredentials?: boolean | { probe?: ClaudeAuthProbe; timeoutMs?: number }
  requireAvailableProfile?: boolean
  listSdkSessions?: SdkSessionLister
  queue?: QueueServerOptions
  // Session-to-session messaging (`peers_list` / `peers_peek` / `peers_send` on every engine). On by default; an
  // operator who wants sessions unable to see each other turns it off here.
  peers?: PeerServiceOptions
  notifications?: SessionNotificationOptions
  bridge?: BridgeHubOptions
  parking?: {
    store?: SessionStore
    parkDelayMs?: number
    expiredGraceMs?: number
    persistLive?: boolean
    onError?: (error: unknown, context: ParkErrorContext) => void
  }
  // Rates the operator knows better than the bundled table does: an enterprise discount, a rate the
  // release predates, a provider the table has no row for. Keyed by canonical model id and merged over
  // `DEFAULT_PRICING` at start, for every pricing call this gateway makes and for the clients it tells.
  pricing?: {
    overrides?: Record<string, ModelRate>
  }
  spend?: {
    store?: SpendStore
    // Keyed by profile name, with '*' as the fallback. The operator's own flat fee, which the gateway has no way
    // to discover: a plan reports its tier, never its price.
    monthlySubscriptionUsd?: Record<string, number>
    onError?: (error: unknown) => void
  }
  createEngineRunner?: (context: EngineRunnerContext) => Runner | Promise<Runner>
  engines?: Partial<Record<ProfileEngine, EngineAdapter>>
}

// The mutual-recursion seam: server.ts builds the services in dependency order, so the ones
// constructed first receive this record and read the later-built services through it lazily.
// Every field is set by the time any request runs.
export type LateBoundRefs = {
  registry?: SessionRegistry
  parking?: SessionParkManager
  bridge?: BridgeHub
}

export type EngineRunnerContext = {
  config: SessionRunnerConfig
  profile: ProfileInfo
  bridge: BridgeHub
  restore?: RunnerSnapshot
  id?: string
}

export type QueueServerOptions = {
  maxConcurrency?: number
  sessionTokenLimit?: number
  dailyTokenLimit?: number
  maxJobDurationMs?: number
  killGraceMs?: number
  retention?: { maxAgeMs: number; sweepIntervalMs?: number }
  adapter?: QueueAdapter
  webhookAttempts?: number
  webhookRetryDelayMs?: number
  onEvent?: (event: JobEvent) => void
}

// A point-in-time answer to "is it safe to stop yet?", as reported while draining.
// A live session handed from one server to another inside one process, which is what `--hot-reload` does: the
// runner object keeps its engine child alive, and `config` is the one fact the next server cannot rederive (a
// durable record strips `env`, `queryFn`, `historyFn` and `extraOptions`, and does not exist before `system_init`).
export type CarriedSession = { runner: Runner; config?: SessionRunnerConfig }

export type DrainReport = {
  // Sessions mid-turn. These resolve on their own, so the drain waits for them.
  working: string[]
  // Sessions blocked on a human - a pending approval. The drain names these but never waits for them: nothing about
  // shutting down will answer the prompt, so waiting is a hang with better manners.
  awaitingHuman: string[]
  // True when the deadline passed with work still running.
  timedOut: boolean
}

export type DrainOptions = {
  // Overall budget. The drain gives up and reports rather than blocking shutdown forever.
  timeoutMs?: number
  pollMs?: number
  onProgress?: (report: DrainReport) => void
}

export type WorkerServer = {
  server: Server
  registry: SessionRegistry
  queue?: JobQueue
  bridge: BridgeHub
  parking: SessionParkManager
  listen: (port: number, host?: string) => Promise<{ port: number }>
  // Let running turns finish before `close()`. A courtesy, never a correctness requirement: records are written
  // continuously, so a hard stop already loses nothing. Refuses new sessions for as long as it runs.
  drain: (options?: DrainOptions) => Promise<DrainReport>
  // Hands a live session out without closing it: unwatches it, detaches everything its registration attached, and
  // returns it with its config. Throws for a session `reloadPlan` says must not be carried by identity, because
  // handing one over is a bug rather than a condition. See docs/GOTCHAS.md under Hot reload.
  releaseSession: (id: string) => CarriedSession | undefined
  // The other half, and it must run BEFORE `listen()`: between the port opening and the adoption, an attach reads
  // the session's dormant record and resumes a second engine child on the same transcript.
  adoptSession: (carried: CarriedSession) => boolean
  close: () => Promise<void>
}
