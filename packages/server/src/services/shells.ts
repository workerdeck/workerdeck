import { mkdtempSync } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHELL_REFUSAL, type Runner } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  SHELL_ARTIFACT_MAX_BYTES,
  SHELL_ARTIFACT_TTL_MS,
  SHELL_INPUT_MAX,
  SHELL_LINGER_MS,
  SHELL_MAX_RUNNING_PER_SESSION,
  SHELL_MAX_RUNNING_TOTAL,
  SHELL_SPILL_BYTES,
  SHELL_TAIL_FLUSH_MS,
  SHELL_TAIL_RING_BYTES,
  type SessionInfo,
  type ShellEndReason,
} from '@workerdeck/protocol'
import { readProcessTable, type TreeKillDeps } from './process-tree.ts'
import { artifactPaths, LiveArtifact, type ArtifactLimits } from './shell-artifact.ts'
import {
  applyAgentWrite,
  attachEntry,
  endEntry,
  fireListeners,
  killTrees,
  newShellInfo,
  readOutput,
  scheduleNotify,
  sourceFor,
  waitForChange,
  wireChild,
} from './shell-entry.ts'
import { clampSize, loadPty, spawnShellChild } from './shell-env.ts'
import { ShellScreen } from './shell-screen.ts'
import { indexedSessions, persistIndex, readIndex, runningIn } from './shell-index.ts'
import type {
  KillTarget,
  PtyChild,
  PtyModule,
  SessionShells,
  ShellEntry,
  ShellErrorReporter,
  ShellRegistry,
  ShellRegistryOptions,
  ShellSpawned,
  ShellSpawnInput,
} from './shell-types.ts'

export { SHELL_REFUSAL }
export { createShellDirectory, startShell, type ShellDirectoryDeps } from './shell-directory.ts'
export { clampSize, loadPty, loginShell, shellChildEnv } from './shell-env.ts'
export type {
  ShellAttachment,
  ShellErrorContext,
  ShellOutputQuery,
  ShellRegistry,
  ShellRegistryOptions,
  ShellSink,
  ShellSize,
  ShellSpawned,
  ShellSpawnInput,
  StoredShellIndex,
  StoredShellRecord,
} from './shell-types.ts'

const SWEEP_INTERVAL_MS = 60 * 60_000

export function shellPermitted(shells: ShellRegistry | null, runner: Runner, operator: boolean): boolean {
  if (shells === null || !operator) {
    return false
  }
  const info = runner.info()
  const capabilities = info.capabilities ?? (info.engine ? ENGINE_CAPABILITIES[info.engine] : undefined)
  return capabilities?.hostCwd === true
}

export function createShellRegistry(options: ShellRegistryOptions): ShellRegistry {
  const { generation } = options
  const dir = options.artifactDir
  const base = dir ?? mkdtempSync(join(tmpdir(), 'workerdeck-shells-'))
  const limits: ArtifactLimits = {
    spill: options.spillBytes ?? SHELL_SPILL_BYTES,
    cap: options.artifactMaxBytes ?? SHELL_ARTIFACT_MAX_BYTES,
    ring: options.tailRingBytes ?? SHELL_TAIL_RING_BYTES,
  }
  const tailFlushMs = options.tailFlushMs ?? SHELL_TAIL_FLUSH_MS
  const ttlMs = options.artifactTtlMs ?? SHELL_ARTIFACT_TTL_MS
  const perSession = options.maxRunningPerSession ?? SHELL_MAX_RUNNING_PER_SESSION
  const total = options.maxRunningTotal ?? SHELL_MAX_RUNNING_TOTAL
  const sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS
  const sessions = new Map<string, SessionShells>()
  const loading = new Map<string, Promise<SessionShells>>()
  let sweeper: NodeJS.Timeout | undefined
  let stopped = false

  const report: ShellErrorReporter = (error, context) => options.onError?.(error, context)
  const treeDeps: TreeKillDeps = {
    table: options.processTable ?? readProcessTable,
    signal: (pid, name) => void process.kill(pid, name),
    self: process.pid,
  }

  const find = (sessionId: string, id: string): ShellEntry | undefined => sessions.get(sessionId)?.entries.get(id)
  const located = (sessionId: string, shellId: string): KillTarget | undefined => {
    const state = sessions.get(sessionId)
    const entry = state?.entries.get(shellId)
    return state && entry ? { state, entry } : undefined
  }
  const runningAll = (): ShellEntry[] => [...sessions.values()].flatMap(runningIn)
  const persist = (state: SessionShells): void => persistIndex(dir, state, report)
  const fire = (entry: ShellEntry): void => fireListeners(entry, report)

  const load = (sessionId: string): Promise<SessionShells> => {
    const held = sessions.get(sessionId)
    if (held) {
      return Promise.resolve(held)
    }
    let inflight = loading.get(sessionId)
    if (!inflight) {
      inflight = readIndex({ dir, generation, report }, sessionId).then((state) => {
        sessions.set(sessionId, state)
        loading.delete(sessionId)
        return state
      })
      loading.set(sessionId, inflight)
    }
    return inflight
  }

  const settle = (state: SessionShells, entry: ShellEntry, reason: ShellEndReason): void => {
    if (entry.info.status !== 'running') {
      return
    }
    endEntry(entry, reason)
    persist(state)
    fire(entry)
  }

  const killEntries = (targets: KillTarget[], reason: ShellEndReason): number => {
    const running = targets.filter(({ entry }) => entry.info.status === 'running')
    killTrees(
      running.map(({ entry }) => entry),
      treeDeps,
      report,
    )
    for (const { state, entry } of running) {
      settle(state, entry, reason)
    }
    return running.length
  }

  const admit = async (runner: Runner): Promise<{ state: SessionShells; cwd: string; pty: PtyModule }> => {
    if (stopped) {
      throw new Error('the gateway is shutting down')
    }
    const state = await load(runner.id)
    const pty = await loadPty()
    if (!pty) {
      throw new Error(SHELL_REFUSAL)
    }
    const cwd = runner.info().cwd
    const dirStat = await stat(cwd).catch(() => undefined)
    if (!dirStat?.isDirectory()) {
      throw new Error(`the session's cwd is not a directory: ${cwd}`)
    }
    const inSession = runningIn(state).length
    if (inSession >= perSession) {
      throw new Error(`this session already has ${inSession} shells running (the limit is ${perSession})`)
    }
    const overall = runningAll().length
    if (overall >= total) {
      throw new Error(`the gateway already has ${overall} shells running (the limit is ${total})`)
    }
    return { state, cwd, pty }
  }

  const spawn = async ({ runner, command, owner }: ShellSpawnInput): Promise<ShellSpawned> => {
    const { state, cwd, pty } = await admit(runner)
    const info = newShellInfo(state, runner.id, command, cwd, owner)
    const artifact = new LiveArtifact(artifactPaths(base, info.sessionId, info.id), limits, (error) =>
      report(error, { op: 'artifact', sessionId: info.sessionId, shellId: info.id }),
    )
    const entry: ShellEntry = { info, generation, artifact, sinks: new Set(), listeners: new Set() }
    entry.screen = new ShellScreen(info.cols, info.rows)
    state.entries.set(info.id, entry)
    let child: PtyChild
    try {
      child = spawnShellChild(pty, cwd, command)
    } catch (error) {
      settle(state, entry, 'spawn_failed')
      throw error instanceof Error ? error : new Error('failed to start the shell')
    }
    wireChild(entry, child, artifact, tailFlushMs, {
      persist: () => persist(state),
      notify: () => scheduleNotify(entry, fire),
      exit: () => settle(state, entry, 'exit'),
    })
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      entry.clock = setTimeout(() => killEntries([{ state, entry }], 'timeout'), options.timeoutMs)
      entry.clock.unref()
    }
    persist(state)
    return { shell: { ...info }, source: sourceFor(entry, artifact) }
  }

  const sweep = async (): Promise<void> => {
    const now = Date.now()
    for (const state of sessions.values()) {
      let dirty = false
      for (const entry of state.entries.values()) {
        const { status, endedAt } = entry.info
        if (status !== 'exited' || endedAt === undefined || now - endedAt < ttlMs) {
          continue
        }
        state.entries.delete(entry.info.id)
        dirty = true
        try {
          await entry.artifact.remove()
        } catch (error) {
          report(error, { op: 'sweep', sessionId: state.sessionId, shellId: entry.info.id })
        }
      }
      if (dirty) {
        persist(state)
      }
    }
  }

  const hydrate = async (): Promise<void> => {
    if (dir) {
      for (const sessionId of await indexedSessions(dir, report)) {
        await load(sessionId)
      }
    }
    await sweep()
    if (!sweeper && !stopped) {
      sweeper = setInterval(() => void sweep(), sweepIntervalMs)
      sweeper.unref()
    }
  }

  const existing = (sessionId: string, shellId: string): ShellEntry => {
    const entry = find(sessionId, shellId)
    if (!entry) {
      throw new Error('unknown shell')
    }
    return entry
  }

  return {
    spawn,
    get: (sessionId, shellId) => {
      const entry = find(sessionId, shellId)
      return entry ? { ...entry.info } : undefined
    },
    list: (sessionId) => {
      const state = sessions.get(sessionId)
      if (!state) {
        return []
      }
      return [...state.entries.values()].map((entry) => ({ ...entry.info })).sort((a, b) => b.ordinal - a.ordinal)
    },
    running: () => runningAll().map((entry) => ({ ...entry.info })),
    kill: (sessionId, shellId, reason = 'killed') => {
      const target = located(sessionId, shellId)
      if (!target) {
        return undefined
      }
      killEntries([target], reason)
      return { ...target.entry.info }
    },
    setAgentWrite: (sessionId, shellId, enabled) => {
      const target = located(sessionId, shellId)
      if (!target) {
        return undefined
      }
      if (applyAgentWrite(target.entry, shellId, enabled)) {
        persist(target.state)
        fire(target.entry)
      }
      return { ...target.entry.info }
    },
    killAll: (reason) => {
      stopped = true
      if (sweeper) {
        clearInterval(sweeper)
        sweeper = undefined
      }
      return killEntries(
        [...sessions.values()].flatMap((state) => runningIn(state).map((entry) => ({ state, entry }))),
        reason,
      )
    },
    killAllSync: () => {
      killTrees(runningAll(), treeDeps, report)
    },
    attach: async (sessionId, shellId, sink) => attachEntry(existing(sessionId, shellId), sink),
    write: (sessionId, shellId, data) => {
      const entry = existing(sessionId, shellId)
      if (typeof data !== 'string' || data.length > SHELL_INPUT_MAX) {
        throw new Error(`shell input must be a string of at most ${SHELL_INPUT_MAX} characters`)
      }
      if (!entry.child) {
        throw new Error('the shell has exited')
      }
      entry.child.write(data)
    },
    resize: (sessionId, shellId, size) => {
      const entry = existing(sessionId, shellId)
      const next = clampSize(size)
      if (entry.child) {
        try {
          entry.child.resize(next.cols, next.rows)
        } catch {}
        entry.info.cols = next.cols
        entry.info.rows = next.rows
        entry.screen?.resize(next.cols, next.rows)
      }
      return next
    },
    output: async (sessionId, shellId, query) => {
      const entry = find(sessionId, shellId)
      return entry ? readOutput(entry, query) : undefined
    },
    applicationCursorKeys: (sessionId, shellId) => find(sessionId, shellId)?.screen?.applicationCursorKeys() ?? Promise.resolve(false),
    changed: (sessionId, shellId, timeoutMs) => waitForChange(find(sessionId, shellId), timeoutMs),
    hydrate,
    sweep,
    flush: async () => {
      const states = [...sessions.values()]
      await Promise.all(states.flatMap((state) => [...state.entries.values()].map((entry) => entry.artifact.idle())))
      await Promise.all(states.map((state) => state.chain))
      if (!dir && stopped) {
        await rm(base, { recursive: true, force: true }).catch(() => {})
      }
    },
    decorate: (info) => decorateSession(info, sessions.get(info.id)),
    watch: (runner) =>
      runner.subscribe((event) => {
        if (event.type === 'session_closed' || (event.type === 'status_changed' && event.status === 'parked')) {
          const state = sessions.get(runner.id)
          if (state) {
            killEntries(
              runningIn(state).map((entry) => ({ state, entry })),
              'killed',
            )
          }
        }
      }, runner.info().lastSeq),
  }
}

function decorateSession(info: SessionInfo, state: SessionShells | undefined): SessionInfo {
  if (!state) {
    return info
  }
  const now = Date.now()
  const shells = [...state.entries.values()]
    .filter((entry) => {
      const { status, exitCode, endedAt } = entry.info
      return (
        status === 'running' || (typeof exitCode === 'number' && exitCode !== 0 && endedAt !== undefined && now - endedAt < SHELL_LINGER_MS)
      )
    })
    .map((entry) => ({ ...entry.info }))
  return shells.length > 0 ? { ...info, shells } : info
}
