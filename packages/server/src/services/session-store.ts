import type { CostLedgerState, ParkedExecution, RunnerSnapshot, SessionRunnerConfig } from '@workerdeck/core'
import { ENGINE_CAPABILITIES, pickCreateSessionRequest, type SessionInfo } from '@workerdeck/protocol'
import { DURABLE_HOST_KEYS } from '../lib/host-only-keys.ts'
import { engineOf } from '../lib/profile-env.ts'

export type ParkedSessionRecord = {
  kind?: 'parked' | 'live'
  id: string
  info: SessionInfo
  profile?: string
  config: SessionRunnerConfig
  snapshot: RunnerSnapshot
  executions: ParkedExecution[]
  cost?: CostLedgerState
  parkedAt: number
}

export function isLiveRecord(record: StoredSessionRecord): boolean {
  return record.kind === 'live'
}

export type DormantSessionRecord = {
  kind: 'dormant'
  id: string
  info: SessionInfo
  profile?: string
  config: SessionRunnerConfig
  // Absent until the engine has named its conversation: such a record wakes into a fresh one.
  sdkSessionId?: string
  cost?: CostLedgerState
  savedAt: number
}

export type EngineHome = { claudeConfigDir?: string; codexHome?: string }

// What a conversation leaves for its history entry, taken from the live runner or the stored runtime.
export type SessionCapture = {
  id: string
  info: SessionInfo
  config: SessionRunnerConfig
  engineSessionId?: string
  profile?: string
  home?: EngineHome
  snapshot?: RunnerSnapshot
}

export type RunnableSessionRecord = ParkedSessionRecord | DormantSessionRecord

export type StoredSessionRecord = RunnableSessionRecord

export function isDormant(record: StoredSessionRecord): record is DormantSessionRecord {
  return record.kind === 'dormant'
}

export interface SessionStore {
  save(record: StoredSessionRecord): Promise<void>
  get(id: string): Promise<StoredSessionRecord | null>
  list(): Promise<StoredSessionRecord[]>
  delete(id: string, conversation?: number, reason?: RuntimeClear): Promise<boolean>
}

export type RuntimeClear = 'ended' | 'resumed'

export function durableConfig(config: SessionRunnerConfig): SessionRunnerConfig {
  const source = config as Record<string, unknown>
  const durable: Record<string, unknown> = { ...pickCreateSessionRequest(source) }
  for (const key of DURABLE_HOST_KEYS) {
    if (source[key] !== undefined) {
      durable[key] = source[key]
    }
  }
  return durable as SessionRunnerConfig
}

export function toDurableRecord<T extends StoredSessionRecord>(record: T): T {
  return { ...record, config: durableConfig(record.config) }
}

export function parseStoredRecord(value: unknown): StoredSessionRecord | null {
  const record = value as Partial<StoredSessionRecord> | null
  if (!record || typeof record !== 'object') {
    return null
  }
  if (typeof record.id !== 'string') {
    return null
  }
  if (!record.info || !record.config) {
    return null
  }
  if ((record as { kind?: string }).kind === 'archived') {
    return null
  }
  record.info = withCurrentCapabilities(record.info)
  if (record.kind === 'dormant') {
    const dormant = record as Partial<DormantSessionRecord>
    if ((dormant.sdkSessionId !== undefined && typeof dormant.sdkSessionId !== 'string') || typeof dormant.savedAt !== 'number') {
      return null
    }
    return dormant as DormantSessionRecord
  }
  const parked = record as Partial<ParkedSessionRecord>
  if (typeof parked.parkedAt !== 'number' || !parked.snapshot) {
    return null
  }
  if (!Array.isArray(parked.executions)) {
    return null
  }
  return parked as ParkedSessionRecord
}

// A record parked by an older gateway lacks capability keys added since; the engine's defaults fill them, so a
// client never reads a SessionInfo missing a required key. Stored keys win: a sandboxed profile narrows them.
function withCurrentCapabilities(info: SessionInfo): SessionInfo {
  if (!info.capabilities) {
    return info
  }
  return { ...info, capabilities: { ...ENGINE_CAPABILITIES[engineOf(info)], ...info.capabilities } }
}
