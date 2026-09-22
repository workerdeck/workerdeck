import { randomBytes } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ttyText, type LocalShellSource, type Runner } from '@workerdeck/core'
import {
  ENGINE_CAPABILITIES,
  SHELL_ARTIFACT_MAX_BYTES,
  SHELL_ARTIFACT_TTL_MS,
  SHELL_ATTACH_REPLAY_BYTES,
  SHELL_COLS,
  SHELL_INPUT_MAX,
  SHELL_LABEL_MAX,
  SHELL_LINGER_MS,
  SHELL_MAX_COLS,
  SHELL_MAX_ROWS,
  SHELL_MAX_RUNNING_PER_SESSION,
  SHELL_MAX_RUNNING_TOTAL,
  SHELL_MIN_COLS,
  SHELL_MIN_ROWS,
  SHELL_ROWS,
  SHELL_SPILL_BYTES,
  SHELL_TAIL_FLUSH_MS,
  SHELL_TAIL_RING_BYTES,
  type SessionInfo,
  type ShellEndReason,
  type ShellInfo,
  type ShellOwner,
} from '@workerdeck/protocol'

export const SHELL_REFUSAL = 'shell commands are not available on this session'

const NOTIFY_MS = 250
const SWEEP_INTERVAL_MS = 60 * 60_000
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_CHARS = 12
const TERM = 'xterm-256color'
const INDEX_SUFFIX = '.json'
const INDEX_VERSION = 1

export type ShellSize = { cols: number; rows: number }

export type ShellSink = { write: (data: string) => void; end: (reason: string) => void }

export type ShellSpawnInput = { runner: Runner; command: string; owner: ShellOwner }

export type ShellSpawned = { shell: ShellInfo; source: LocalShellSource }

export type ShellAttachment = { shell: ShellInfo; scrollback: string; detach: () => void }

export type ShellOutputQuery = { view: 'text' | 'raw'; tail?: number }

export type ShellErrorContext = { op: 'index' | 'artifact' | 'sweep' | 'listener'; sessionId?: string; shellId?: string }

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
  onError?: (error: unknown, context: ShellErrorContext) => void
}

export type StoredShellRecord = ShellInfo & { generation: string; output?: string; artifact?: string }

export type StoredShellIndex = { version: 1; sessionId: string; nextOrdinal: number; shells: StoredShellRecord[] }

export type ShellRegistry = {
  spawn: (input: ShellSpawnInput) => Promise<ShellSpawned>
  get: (sessionId: string, shellId: string) => ShellInfo | undefined
  list: (sessionId: string) => ShellInfo[]
  running: () => ShellInfo[]
  kill: (sessionId: string, shellId: string, reason?: ShellEndReason) => ShellInfo | undefined
  killAll: (reason: ShellEndReason) => number
  killAllSync: () => void
  attach: (sessionId: string, shellId: string, sink: ShellSink) => Promise<ShellAttachment>
  write: (sessionId: string, shellId: string, data: string) => void
  resize: (sessionId: string, shellId: string, size: ShellSize) => ShellSize
  output: (sessionId: string, shellId: string, query: ShellOutputQuery) => Promise<string | undefined>
  hydrate: () => Promise<void>
  sweep: () => Promise<void>
  flush: () => Promise<void>
  decorate: (info: SessionInfo) => SessionInfo
  watch: (runner: Runner) => () => void
}

type PtyChild = {
  readonly pid: number
  onData: (listener: (data: string) => void) => void
  onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: (signal?: string) => void
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ) => PtyChild
}

type ArtifactLimits = { spill: number; cap: number; ring: number }

type ArtifactPaths = { dir: string; raw: string; tail: string; rel: string }

type StoredOutput = { output?: string; artifact?: string }

type ShellArtifact = LiveArtifact | StoredArtifact

type ShellEntry = {
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
}

type SessionShells = {
  sessionId: string
  nextOrdinal: number
  entries: Map<string, ShellEntry>
  chain: Promise<void>
  pending: boolean
}

let ptyModule: PtyModule | null | undefined

export async function loadPty(): Promise<PtyModule | null> {
  if (ptyModule !== undefined) {
    return ptyModule
  }
  try {
    ptyModule = (await import('@lydell/node-pty')) as unknown as PtyModule
  } catch {
    ptyModule = null
  }
  return ptyModule
}

export function shellPermitted(shells: ShellRegistry | null, runner: Runner, operator: boolean): boolean {
  if (shells === null || !operator) {
    return false
  }
  const info = runner.info()
  const capabilities = info.capabilities ?? (info.engine ? ENGINE_CAPABILITIES[info.engine] : undefined)
  return capabilities?.hostCwd === true
}

// A spawn env replaces the inherited one wholesale, so the copy has to be complete; the gateway's own environment is
// what the operator's terminal would have given the same command.
export function shellChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}

export function clampSize(size: ShellSize): ShellSize {
  return {
    cols: clamp(size.cols, SHELL_MIN_COLS, SHELL_MAX_COLS),
    rows: clamp(size.rows, SHELL_MIN_ROWS, SHELL_MAX_ROWS),
  }
}

export function loginShell(env: Record<string, string | undefined>): string {
  const shell = env.SHELL
  return shell && shell.startsWith('/') ? shell : '/bin/sh'
}

export function createShellRegistry(options: ShellRegistryOptions): ShellRegistry {
  const { generation } = options
  const dir = options.artifactDir
  const base = dir ?? join(tmpdir(), `workerdeck-shells-${process.pid}`)
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

  const report = (error: unknown, context: ShellErrorContext): void => options.onError?.(error, context)

  const indexPath = (sessionId: string): string => join(base, `${encodeURIComponent(sessionId)}${INDEX_SUFFIX}`)

  const pathsFor = (sessionId: string, shellId: string): ArtifactPaths => {
    const encoded = encodeURIComponent(sessionId)
    const sessionDir = join(base, encoded)
    return {
      dir: sessionDir,
      raw: join(sessionDir, `${shellId}.raw`),
      tail: join(sessionDir, `${shellId}.tail.raw`),
      rel: `${encoded}/${shellId}.raw`,
    }
  }

  const find = (sessionId: string, id: string): ShellEntry | undefined => sessions.get(sessionId)?.entries.get(id)

  const runningAll = (): ShellEntry[] => [...sessions.values()].flatMap(runningIn)

  const persist = (state: SessionShells): void => {
    if (!dir || state.pending) {
      return
    }
    state.pending = true
    state.chain = state.chain
      .then(async () => {
        state.pending = false
        const payload = JSON.stringify(serialize(state))
        await mkdir(dir, { recursive: true, mode: 0o700 })
        const path = indexPath(state.sessionId)
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, payload, { mode: 0o600 })
        await rename(temp, path)
      })
      .catch((error: unknown) => report(error, { op: 'index', sessionId: state.sessionId }))
  }

  const readIndex = async (sessionId: string): Promise<SessionShells> => {
    const state = freshSession(sessionId)
    if (!dir) {
      return state
    }
    let raw: string
    try {
      raw = await readFile(indexPath(sessionId), 'utf8')
    } catch (error) {
      if (!isMissing(error)) {
        report(error, { op: 'index', sessionId })
      }
      return state
    }
    let index: StoredShellIndex
    try {
      index = parseIndex(JSON.parse(raw))
    } catch (error) {
      report(error, { op: 'index', sessionId })
      return state
    }
    state.nextOrdinal = index.nextOrdinal
    const now = Date.now()
    let dirty = false
    for (const record of index.shells) {
      const { generation: recordGeneration, output, artifact, ...info } = record
      if (info.status === 'running' && recordGeneration !== generation) {
        info.status = 'exited'
        info.endReason = 'server_restarted'
        info.endedAt = now
        delete info.exitCode
        delete info.signal
        dirty = true
      }
      state.entries.set(info.id, {
        info,
        generation: recordGeneration,
        artifact: new StoredArtifact(pathsFor(sessionId, info.id), info, { output, artifact }),
        sinks: new Set(),
        listeners: new Set(),
      })
    }
    if (dirty) {
      persist(state)
    }
    return state
  }

  const load = (sessionId: string): Promise<SessionShells> => {
    const held = sessions.get(sessionId)
    if (held) {
      return Promise.resolve(held)
    }
    let inflight = loading.get(sessionId)
    if (!inflight) {
      inflight = readIndex(sessionId).then((state) => {
        sessions.set(sessionId, state)
        loading.delete(sessionId)
        return state
      })
      loading.set(sessionId, inflight)
    }
    return inflight
  }

  const fire = (entry: ShellEntry): void => {
    for (const listener of entry.listeners) {
      try {
        listener()
      } catch (error) {
        report(error, { op: 'listener', sessionId: entry.info.sessionId, shellId: entry.info.id })
      }
    }
  }

  const scheduleNotify = (entry: ShellEntry): void => {
    if (entry.notify) {
      return
    }
    entry.notify = setTimeout(() => {
      entry.notify = undefined
      if (entry.info.status === 'running') {
        fire(entry)
      }
    }, NOTIFY_MS)
    entry.notify.unref()
  }

  const settle = (state: SessionShells, entry: ShellEntry, reason: ShellEndReason): void => {
    if (entry.info.status !== 'running') {
      return
    }
    entry.info.status = 'exited'
    entry.info.endedAt = Date.now()
    entry.info.endReason = reason
    clearTimeout(entry.clock)
    clearTimeout(entry.notify)
    clearInterval(entry.tailTimer)
    entry.clock = entry.notify = entry.tailTimer = undefined
    entry.child = undefined
    entry.pid = undefined
    if (entry.artifact instanceof LiveArtifact) {
      entry.artifact.close()
    }
    for (const sink of entry.sinks) {
      try {
        sink.end(reason)
      } catch {}
    }
    entry.sinks.clear()
    persist(state)
    fire(entry)
  }

  const kill = (state: SessionShells, entry: ShellEntry, reason: ShellEndReason): void => {
    if (entry.info.status !== 'running') {
      return
    }
    killGroup(entry)
    settle(state, entry, reason)
  }

  const killSession = (sessionId: string, reason: ShellEndReason): void => {
    const state = sessions.get(sessionId)
    if (!state) {
      return
    }
    for (const entry of runningIn(state)) {
      kill(state, entry, reason)
    }
  }

  const spawn = async ({ runner, command, owner }: ShellSpawnInput): Promise<ShellSpawned> => {
    if (stopped) {
      throw new Error('the gateway is shutting down')
    }
    const sessionId = runner.id
    const state = await load(sessionId)
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
    const id = mintShellId()
    const info: ShellInfo = {
      id,
      sessionId,
      ordinal: state.nextOrdinal++,
      command,
      label: shellLabel(command),
      cwd,
      owner,
      status: 'running',
      startedAt: Date.now(),
      bytes: 0,
      cols: SHELL_COLS,
      rows: SHELL_ROWS,
    }
    const artifact = new LiveArtifact(pathsFor(sessionId, id), limits, (error) => report(error, { op: 'artifact', sessionId, shellId: id }))
    const entry: ShellEntry = { info, generation, artifact, sinks: new Set(), listeners: new Set() }
    state.entries.set(id, entry)
    const env = shellChildEnv(process.env)
    env.TERM = TERM
    env.COLORTERM = 'truecolor'
    env.PWD = cwd
    let child: PtyChild
    try {
      child = pty.spawn(loginShell(process.env), ['-c', command], { name: TERM, cols: SHELL_COLS, rows: SHELL_ROWS, cwd, env })
    } catch (error) {
      settle(state, entry, 'spawn_failed')
      throw error instanceof Error ? error : new Error('failed to start the shell')
    }
    entry.child = child
    entry.pid = child.pid
    child.onData((data) => {
      if (entry.info.status !== 'running') {
        return
      }
      const changed = artifact.append(data)
      entry.info.bytes = artifact.bytes
      if (changed) {
        if (artifact.capped && !entry.info.capped) {
          entry.info.capped = true
          entry.tailTimer = setInterval(() => artifact.writeTail(), tailFlushMs)
          entry.tailTimer.unref()
        }
        persist(state)
      }
      for (const sink of entry.sinks) {
        try {
          sink.write(data)
        } catch {
          entry.sinks.delete(sink)
        }
      }
      scheduleNotify(entry)
    })
    child.onExit(({ exitCode, signal }) => {
      if (entry.info.status !== 'running') {
        return
      }
      if (signal) {
        entry.info.signal = signal
      } else {
        entry.info.exitCode = exitCode
      }
      settle(state, entry, 'exit')
    })
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      entry.clock = setTimeout(() => kill(state, entry, 'timeout'), options.timeoutMs)
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
      const state = sessions.get(sessionId)
      const entry = state?.entries.get(shellId)
      if (!state || !entry) {
        return undefined
      }
      kill(state, entry, reason)
      return { ...entry.info }
    },
    killAll: (reason) => {
      stopped = true
      if (sweeper) {
        clearInterval(sweeper)
        sweeper = undefined
      }
      let killed = 0
      for (const state of sessions.values()) {
        for (const entry of runningIn(state)) {
          kill(state, entry, reason)
          killed++
        }
      }
      return killed
    },
    killAllSync: () => {
      for (const entry of runningAll()) {
        if (entry.pid === undefined) {
          continue
        }
        try {
          process.kill(-entry.pid, 'SIGKILL')
        } catch {}
      }
    },
    attach: async (sessionId, shellId, sink) => {
      const entry = find(sessionId, shellId)
      if (!entry) {
        throw new Error('unknown shell')
      }
      const pending: string[] = []
      let live = false
      let ended: string | undefined
      const proxy: ShellSink = {
        write: (data) => {
          if (live) {
            sink.write(data)
          } else {
            pending.push(data)
          }
        },
        end: (reason) => {
          if (live) {
            sink.end(reason)
          } else {
            ended = reason
          }
        },
      }
      if (entry.info.status === 'running') {
        entry.sinks.add(proxy)
      }
      let replay: Buffer
      try {
        replay = await entry.artifact.replay(SHELL_ATTACH_REPLAY_BYTES)
      } catch (error) {
        entry.sinks.delete(proxy)
        throw error
      }
      live = true
      if (ended !== undefined) {
        const reason = ended
        queueMicrotask(() => sink.end(reason))
      }
      return {
        shell: { ...entry.info },
        scrollback: replay.toString('utf8') + pending.join(''),
        detach: () => {
          entry.sinks.delete(proxy)
        },
      }
    },
    write: (sessionId, shellId, data) => {
      const entry = find(sessionId, shellId)
      if (!entry) {
        throw new Error('unknown shell')
      }
      if (typeof data !== 'string' || data.length > SHELL_INPUT_MAX) {
        throw new Error(`shell input must be a string of at most ${SHELL_INPUT_MAX} characters`)
      }
      if (!entry.child) {
        throw new Error('the shell has exited')
      }
      entry.child.write(data)
    },
    resize: (sessionId, shellId, size) => {
      const entry = find(sessionId, shellId)
      if (!entry) {
        throw new Error('unknown shell')
      }
      const next = clampSize(size)
      if (entry.child) {
        try {
          entry.child.resize(next.cols, next.rows)
        } catch {}
        entry.info.cols = next.cols
        entry.info.rows = next.rows
      }
      return next
    },
    output: async (sessionId, shellId, query) => {
      const entry = find(sessionId, shellId)
      if (!entry) {
        return undefined
      }
      if (query.tail === undefined && query.view === 'text') {
        return entry.artifact.textView()
      }
      const raw = await entry.artifact.read(query.tail)
      const text = raw.toString('utf8')
      return query.view === 'raw' ? text : ttyText(text)
    },
    hydrate: async () => {
      if (dir) {
        let names: string[] = []
        try {
          names = await readdir(dir)
        } catch (error) {
          if (!isMissing(error)) {
            report(error, { op: 'index' })
          }
        }
        for (const name of names) {
          if (!name.endsWith(INDEX_SUFFIX)) {
            continue
          }
          let sessionId: string
          try {
            sessionId = decodeURIComponent(name.slice(0, -INDEX_SUFFIX.length))
          } catch {
            continue
          }
          await load(sessionId)
        }
      }
      await sweep()
      if (!sweeper && !stopped) {
        sweeper = setInterval(() => void sweep(), sweepIntervalMs)
        sweeper.unref()
      }
    },
    sweep,
    flush: async () => {
      const states = [...sessions.values()]
      await Promise.all(states.flatMap((state) => [...state.entries.values()].map((entry) => entry.artifact.idle())))
      await Promise.all(states.map((state) => state.chain))
      if (!dir && stopped) {
        await rm(base, { recursive: true, force: true }).catch(() => {})
      }
    },
    decorate: (info) => {
      const state = sessions.get(info.id)
      if (!state) {
        return info
      }
      const now = Date.now()
      const shells = [...state.entries.values()]
        .filter((entry) => {
          const { status, exitCode, endedAt } = entry.info
          return status === 'running' || (exitCode !== 0 && endedAt !== undefined && now - endedAt < SHELL_LINGER_MS)
        })
        .map((entry) => ({ ...entry.info }))
      return shells.length > 0 ? { ...info, shells } : info
    },
    watch: (runner) =>
      runner.subscribe((event) => {
        if (event.type === 'session_closed' || (event.type === 'status_changed' && event.status === 'parked')) {
          killSession(runner.id, 'killed')
        }
      }, runner.info().lastSeq),
  }
}

class LiveArtifact {
  readonly #paths: ArtifactPaths
  readonly #limits: ArtifactLimits
  readonly #onError: (error: unknown) => void
  readonly #ring: Buffer
  #ringAt = 0
  #ringLen = 0
  #chunks: Buffer[] = []
  #chunkBytes = 0
  #bytes = 0
  #spilled = false
  #capped = false
  #closed = false
  #broken = false
  #io: Promise<void> = Promise.resolve()
  #handle: FileHandle | undefined
  #done = ''
  #pending = ''
  #textCache: string | undefined

  constructor(paths: ArtifactPaths, limits: ArtifactLimits, onError: (error: unknown) => void) {
    this.#paths = paths
    this.#limits = limits
    this.#onError = onError
    this.#ring = Buffer.alloc(Math.max(0, limits.ring))
  }

  get bytes(): number {
    return this.#bytes
  }

  get capped(): boolean {
    return this.#capped
  }

  append(data: string): boolean {
    const chunk = Buffer.from(data, 'utf8')
    const before = this.#bytes
    this.#bytes += chunk.length
    this.#ringPush(chunk)
    this.#textCache = undefined
    if (this.#capped) {
      return false
    }
    const room = Math.max(0, this.#limits.cap - before)
    const kept = chunk.length <= room ? chunk : chunk.subarray(0, room)
    this.#textAppend(kept === chunk ? data : kept.toString('utf8'))
    let changed = false
    if (this.#spilled) {
      this.#write(kept)
    } else {
      this.#chunks.push(kept)
      this.#chunkBytes += kept.length
      if (this.#chunkBytes > this.#limits.spill) {
        this.#spill()
        changed = true
      }
    }
    if (this.#bytes > this.#limits.cap) {
      this.#capped = true
      changed = true
    }
    return changed
  }

  text(): string {
    if (this.#textCache === undefined) {
      let text = this.#done + ttyText(this.#pending)
      if (this.#capped) {
        const after = this.#bytes - this.#limits.cap
        const kept = Math.min(after, this.#ringLen)
        if (kept > 0) {
          text += (after > kept ? '\n' : '') + ttyText(this.tail(kept).toString('utf8'))
        }
      }
      this.#textCache = text
    }
    return this.#textCache
  }

  textView(): Promise<string> {
    return Promise.resolve(this.text())
  }

  tail(n: number = this.#ringLen): Buffer {
    const size = this.#ring.length
    const take = Math.max(0, Math.min(n, this.#ringLen))
    const out = Buffer.allocUnsafe(take)
    if (take === 0) {
      return out
    }
    const start = (this.#ringAt - take + size) % size
    const first = Math.min(take, size - start)
    this.#ring.copy(out, 0, start, start + first)
    if (first < take) {
      this.#ring.copy(out, first, 0, take - first)
    }
    return out
  }

  replay(max: number): Promise<Buffer> {
    const want = Math.max(0, Math.floor(max))
    if (!this.#spilled) {
      const all = Buffer.concat(this.#chunks, this.#chunkBytes)
      return Promise.resolve(all.subarray(Math.max(0, all.length - want)))
    }
    if (this.#capped || want <= this.#ringLen) {
      return Promise.resolve(this.tail(want))
    }
    const end = this.#bytes
    return this.#io.then(() => readRange(this.#paths.raw, Math.max(0, end - want), end))
  }

  async read(tail?: number): Promise<Buffer> {
    if (tail !== undefined) {
      return this.replay(tail)
    }
    if (!this.#spilled) {
      return Buffer.concat(this.#chunks, this.#chunkBytes)
    }
    await this.#io
    return readWhole(this.#paths.raw)
  }

  stored(): StoredOutput {
    return this.#spilled ? { artifact: this.#paths.rel } : { output: Buffer.concat(this.#chunks, this.#chunkBytes).toString('utf8') }
  }

  writeTail(): void {
    const tail = this.tail()
    this.#queue(async () => {
      await mkdir(this.#paths.dir, { recursive: true, mode: 0o700 })
      const temp = `${this.#paths.tail}.${process.pid}.tmp`
      await writeFile(temp, tail, { mode: 0o600 })
      await rename(temp, this.#paths.tail)
    })
  }

  close(): void {
    if (this.#closed) {
      return
    }
    this.#closed = true
    if (this.#capped) {
      this.writeTail()
    }
    this.#io = this.#io.then(async () => {
      const handle = this.#handle
      this.#handle = undefined
      await handle?.close().catch(() => {})
    })
  }

  idle(): Promise<void> {
    return this.#io
  }

  async remove(): Promise<void> {
    this.close()
    await this.#io
    await rm(this.#paths.raw, { force: true })
    await rm(this.#paths.tail, { force: true })
  }

  // Only the new chunk is searched: `#pending` holds no newline by construction, and scanning it again per chunk
  // made one long line quadratic.
  #textAppend(data: string): void {
    const newline = data.lastIndexOf('\n')
    if (newline === -1) {
      this.#pending += data
      return
    }
    this.#done += ttyText(this.#pending + data.slice(0, newline + 1))
    this.#pending = data.slice(newline + 1)
  }

  #ringPush(chunk: Buffer): void {
    const size = this.#ring.length
    if (size === 0 || chunk.length === 0) {
      return
    }
    if (chunk.length >= size) {
      chunk.copy(this.#ring, 0, chunk.length - size)
      this.#ringAt = 0
      this.#ringLen = size
      return
    }
    const first = Math.min(chunk.length, size - this.#ringAt)
    chunk.copy(this.#ring, this.#ringAt, 0, first)
    if (first < chunk.length) {
      chunk.copy(this.#ring, 0, first)
    }
    this.#ringAt = (this.#ringAt + chunk.length) % size
    this.#ringLen = Math.min(size, this.#ringLen + chunk.length)
  }

  #spill(): void {
    this.#spilled = true
    const buffered = Buffer.concat(this.#chunks, this.#chunkBytes)
    this.#chunks = []
    this.#chunkBytes = 0
    this.#queue(async () => {
      await mkdir(this.#paths.dir, { recursive: true, mode: 0o700 })
      this.#handle = await open(this.#paths.raw, 'w', 0o600)
      await this.#handle.write(buffered)
    })
  }

  #write(chunk: Buffer): void {
    if (chunk.length === 0) {
      return
    }
    this.#queue(async () => {
      await this.#handle?.write(chunk)
    })
  }

  #queue(task: () => Promise<void>): void {
    this.#io = this.#io.then(async () => {
      if (this.#broken) {
        return
      }
      try {
        await task()
      } catch (error) {
        this.#broken = true
        this.#onError(error)
      }
    })
  }
}

class StoredArtifact {
  readonly #paths: ArtifactPaths
  readonly #bytes: number
  readonly #capped: boolean
  readonly #stored: StoredOutput

  constructor(paths: ArtifactPaths, info: { bytes: number; capped?: boolean }, stored: StoredOutput) {
    this.#paths = paths
    this.#bytes = info.bytes
    this.#capped = info.capped === true
    this.#stored = stored.artifact !== undefined ? { artifact: stored.artifact } : { output: stored.output ?? '' }
  }

  async read(tail?: number): Promise<Buffer> {
    if (tail !== undefined) {
      return this.replay(tail)
    }
    return this.#head()
  }

  async replay(max: number): Promise<Buffer> {
    const want = Math.max(0, Math.floor(max))
    if (this.#capped) {
      const ring = await readWhole(this.#paths.tail)
      return ring.subarray(Math.max(0, ring.length - want))
    }
    if (this.#stored.output !== undefined) {
      const all = Buffer.from(this.#stored.output, 'utf8')
      return all.subarray(Math.max(0, all.length - want))
    }
    const size = await stat(this.#paths.raw).then(
      (s) => s.size,
      () => 0,
    )
    return readRange(this.#paths.raw, Math.max(0, size - want), size)
  }

  async textView(): Promise<string> {
    const head = await this.#head()
    let text = ttyText(head.toString('utf8'))
    if (this.#capped) {
      const ring = await readWhole(this.#paths.tail)
      const after = this.#bytes - head.length
      const kept = Math.min(after, ring.length)
      if (kept > 0) {
        text += (after > kept ? '\n' : '') + ttyText(ring.subarray(ring.length - kept).toString('utf8'))
      }
    }
    return text
  }

  stored(): StoredOutput {
    return this.#stored
  }

  idle(): Promise<void> {
    return Promise.resolve()
  }

  async remove(): Promise<void> {
    await rm(this.#paths.raw, { force: true })
    await rm(this.#paths.tail, { force: true })
  }

  #head(): Promise<Buffer> {
    return this.#stored.output !== undefined ? Promise.resolve(Buffer.from(this.#stored.output, 'utf8')) : readWhole(this.#paths.raw)
  }
}

function serialize(state: SessionShells): StoredShellIndex {
  return {
    version: INDEX_VERSION,
    sessionId: state.sessionId,
    nextOrdinal: state.nextOrdinal,
    shells: [...state.entries.values()].map((entry) => ({ ...entry.info, generation: entry.generation, ...entry.artifact.stored() })),
  }
}

function parseIndex(value: unknown): StoredShellIndex {
  const index = value as Partial<StoredShellIndex> | null
  if (!index || index.version !== INDEX_VERSION || typeof index.sessionId !== 'string' || !Array.isArray(index.shells)) {
    throw new Error('unrecognised shell index')
  }
  const shells = index.shells.filter(
    (record): record is StoredShellRecord =>
      typeof record === 'object' && record !== null && typeof (record as StoredShellRecord).id === 'string',
  )
  const nextOrdinal = typeof index.nextOrdinal === 'number' && index.nextOrdinal > 0 ? index.nextOrdinal : 1
  return { version: INDEX_VERSION, sessionId: index.sessionId, nextOrdinal, shells }
}

function freshSession(sessionId: string): SessionShells {
  return { sessionId, nextOrdinal: 1, entries: new Map(), chain: Promise.resolve(), pending: false }
}

function runningIn(state: SessionShells): ShellEntry[] {
  return [...state.entries.values()].filter((entry) => entry.info.status === 'running')
}

function killGroup(entry: ShellEntry): void {
  if (entry.pid === undefined) {
    return
  }
  try {
    process.kill(-entry.pid, 'SIGKILL')
  } catch {
    try {
      entry.child?.kill('SIGKILL')
    } catch {}
  }
}

function sourceFor(entry: ShellEntry, artifact: LiveArtifact): LocalShellSource {
  return {
    info: () => entry.info,
    text: () => artifact.text(),
    subscribe: (listener) => {
      entry.listeners.add(listener)
      return () => {
        entry.listeners.delete(listener)
      }
    },
  }
}

function mintShellId(): string {
  const bytes = randomBytes(ID_CHARS)
  let id = 'sh_'
  for (let i = 0; i < ID_CHARS; i++) {
    id += ID_ALPHABET[bytes[i]! & 31]
  }
  return id
}

function shellLabel(command: string): string {
  const first = command.split('\n')[0] ?? ''
  return first.trim().slice(0, SHELL_LABEL_MAX)
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function readWhole(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissing(error)) {
      return Buffer.alloc(0)
    }
    throw error
  }
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start)
  if (length === 0) {
    return Buffer.alloc(0)
  }
  let handle: FileHandle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if (isMissing(error)) {
      return Buffer.alloc(0)
    }
    throw error
  }
  try {
    const out = Buffer.allocUnsafe(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await handle.read(out, got, length - got, start + got)
      if (bytesRead === 0) {
        break
      }
      got += bytesRead
    }
    return got === length ? out : out.subarray(0, got)
  } finally {
    await handle.close()
  }
}
