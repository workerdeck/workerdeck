import type { LocalShellSource, Runner } from '@workerdeck/core'
import type { SessionInfo, ShellEndReason, ShellInfo, ShellOwner } from '@workerdeck/protocol'
import type { ProcessTable } from './process-tree.ts'
import type { ShellArtifact } from './shell-artifact.ts'
import type { ShellScreen } from './shell-screen.ts'

export type ShellSize = { cols: number; rows: number }

export type ShellSink = { write: (data: string) => void; end: (reason: string) => void }

export type ShellSpawnInput = { runner: Runner; command: string; owner: ShellOwner }

export type ShellSpawned = { shell: ShellInfo; source: LocalShellSource }

export type ShellAttachment = { shell: ShellInfo; scrollback: string; detach: () => void }

export type ShellOutputQuery = { view: 'text' | 'raw' | 'screen'; tail?: number }

export type ShellErrorContext = { op: 'index' | 'artifact' | 'sweep' | 'listener' | 'kill'; sessionId?: string; shellId?: string }

export type ShellErrorReporter = (error: unknown, context: ShellErrorContext) => void

export type ShellRegistryOptions = {
  generation: string
  artifactDir: string | null
  timeoutMs?: number
  artifactMaxBytes?: number
  artifactTtlMs?: number
  maxRunningPerSession?: number
  maxRunningTotal?: number
  spillBytes?: number
  tailRingBytes?: number
  tailFlushMs?: number
  sweepIntervalMs?: number
  processTable?: ProcessTable
  onError?: ShellErrorReporter
}

export type StoredShellRecord = ShellInfo & { generation: string; output?: string; artifact?: string }

export type StoredShellIndex = { version: 1; sessionId: string; nextOrdinal: number; shells: StoredShellRecord[] }

export type ShellRegistry = {
  spawn: (input: ShellSpawnInput) => Promise<ShellSpawned>
  get: (sessionId: string, shellId: string) => ShellInfo | undefined
  list: (sessionId: string) => ShellInfo[]
  running: () => ShellInfo[]
  kill: (sessionId: string, shellId: string, reason?: ShellEndReason) => ShellInfo | undefined
  setAgentWrite: (sessionId: string, shellId: string, enabled: boolean) => ShellInfo | undefined
  killAll: (reason: ShellEndReason) => number
  killAllSync: () => void
  attach: (sessionId: string, shellId: string, sink: ShellSink) => Promise<ShellAttachment>
  write: (sessionId: string, shellId: string, data: string) => void
  resize: (sessionId: string, shellId: string, size: ShellSize) => ShellSize
  output: (sessionId: string, shellId: string, query: ShellOutputQuery) => Promise<string | undefined>
  applicationCursorKeys: (sessionId: string, shellId: string) => Promise<boolean>
  changed: (sessionId: string, shellId: string, timeoutMs: number) => Promise<void>
  hydrate: () => Promise<void>
  sweep: () => Promise<void>
  flush: () => Promise<void>
  decorate: (info: SessionInfo) => SessionInfo
  watch: (runner: Runner) => () => void
}

export type PtyChild = {
  readonly pid: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

export type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ) => PtyChild
}

export type ShellEntry = {
  info: ShellInfo
  generation: string
  artifact: ShellArtifact
  child?: PtyChild
  pid?: number
  sinks: Set<ShellSink>
  listeners: Set<() => void>
  notify?: NodeJS.Timeout
  clock?: NodeJS.Timeout
  tailTimer?: NodeJS.Timeout
  redrawCarry?: string
  screen?: ShellScreen
}

export type SessionShells = {
  sessionId: string
  nextOrdinal: number
  entries: Map<string, ShellEntry>
  chain: Promise<void>
  pending: boolean
}

export type KillTarget = { state: SessionShells; entry: ShellEntry }
