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
    onError?: (error: unknown, context: { sessionId: string; phase: 'park' | 'remember' | 'resume' }) => void
  }
  createEngineRunner?: (context: EngineRunnerContext) => Runner | Promise<Runner>
  engines?: Partial<Record<ProfileEngine, EngineAdapter>>
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

export type WorkerServer = {
  server: Server
  registry: SessionRegistry
  queue?: JobQueue
  bridge: BridgeHub
  parking: SessionParkManager
  listen: (port: number, host?: string) => Promise<{ port: number }>
  close: () => Promise<void>
}
