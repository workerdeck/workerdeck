import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ClaudeAuthProbe, EngineAdapter, Runner, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import type { JobQueue, QueueAdapter } from '@workerdeck/queue'
import type { CreateSessionRequest, JobEvent, ProfileEngine, ProfileInfo, SdkSessionSummary, SessionInfo } from '@workerdeck/protocol'
import type { BridgeHub, BridgeHubOptions } from './services/bridge.ts'
import type { SessionNotificationOptions } from './services/notifications.ts'
import type { ParkErrorContext, SessionParkManager } from './services/parking.ts'
import type { ProfileStore } from './services/profile-store.ts'
import type { SessionRegistry } from './services/registry.ts'
import type { SessionStore } from './services/session-store.ts'

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
  requireApiKey?: boolean
  checkCredentials?: boolean | { probe?: ClaudeAuthProbe; timeoutMs?: number }
  requireAvailableProfile?: boolean
  listSdkSessions?: SdkSessionLister
  queue?: QueueServerOptions
  notifications?: SessionNotificationOptions
  bridge?: BridgeHubOptions
  parking?: {
    store?: SessionStore
    parkDelayMs?: number
    expiredGraceMs?: number
    persistLive?: boolean
    onError?: (error: unknown, context: ParkErrorContext) => void
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

/** A point-in-time answer to "is it safe to stop yet?", as reported while draining. */
export type DrainReport = {
  /** Sessions mid-turn. These resolve on their own, so the drain waits for them. */
  working: string[]
  /**
   * Sessions blocked on a human — a pending approval. The drain names these but never waits for them: nothing about
   * shutting down will answer the prompt, so waiting is a hang with better manners.
   */
  awaitingHuman: string[]
  /** True when the deadline passed with work still running. */
  timedOut: boolean
}

export type DrainOptions = {
  /** Overall budget. The drain gives up and reports rather than blocking shutdown forever. */
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
  /**
   * Let running turns finish before `close()`. A courtesy, never a correctness requirement: records are written
   * continuously, so a hard stop already loses nothing. Refuses new sessions for as long as it runs.
   */
  drain: (options?: DrainOptions) => Promise<DrainReport>
  close: () => Promise<void>
}
