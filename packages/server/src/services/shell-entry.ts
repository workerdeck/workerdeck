import { randomBytes } from 'node:crypto'
import { TTY_REDRAW_CARRY, ttyRedraws, ttyText, type LocalShellSource } from '@workerdeck/core'
import {
  SHELL_ATTACH_REPLAY_BYTES,
  SHELL_COLS,
  SHELL_LABEL_MAX,
  SHELL_ROWS,
  type ShellEndReason,
  type ShellInfo,
  type ShellOwner,
} from '@workerdeck/protocol'
import { killProcessTrees, type TreeKillDeps } from './process-tree.ts'
import { LiveArtifact } from './shell-artifact.ts'
import { renderScreen } from './shell-screen.ts'
import type {
  PtyChild,
  SessionShells,
  ShellAttachment,
  ShellEntry,
  ShellErrorContext,
  ShellErrorReporter,
  ShellOutputQuery,
  ShellSink,
} from './shell-types.ts'

const NOTIFY_MS = 250
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const ID_CHARS = 12

export type ChildHooks = { persist: () => void; notify: () => void; exit: () => void }

export function newShellInfo(state: SessionShells, sessionId: string, command: string, cwd: string, owner: ShellOwner): ShellInfo {
  return {
    id: mintShellId(),
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
}

export function wireChild(entry: ShellEntry, child: PtyChild, artifact: LiveArtifact, tailFlushMs: number, hooks: ChildHooks): void {
  entry.child = child
  entry.pid = child.pid
  child.onData((data) => {
    if (entry.info.status !== 'running') {
      return
    }
    const changed = artifact.append(data)
    entry.info.bytes = artifact.bytes
    entry.screen?.write(data)
    if (!entry.info.interactive) {
      const scanned = (entry.redrawCarry ?? '') + data
      if (ttyRedraws(scanned)) {
        entry.info.interactive = true
        entry.redrawCarry = undefined
        hooks.persist()
      } else {
        entry.redrawCarry = scanned.slice(-TTY_REDRAW_CARRY)
      }
    }
    if (changed) {
      if (artifact.capped && !entry.info.capped) {
        entry.info.capped = true
        entry.tailTimer = setInterval(() => artifact.writeTail(), tailFlushMs)
        entry.tailTimer.unref()
      }
      hooks.persist()
    }
    for (const sink of entry.sinks) {
      try {
        sink.write(data)
      } catch {
        entry.sinks.delete(sink)
      }
    }
    hooks.notify()
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
    hooks.exit()
  })
}

export function endEntry(entry: ShellEntry, reason: ShellEndReason): void {
  entry.info.status = 'exited'
  entry.info.endedAt = Date.now()
  entry.info.endReason = reason
  delete entry.info.agentWrite
  clearTimeout(entry.clock)
  clearTimeout(entry.notify)
  clearInterval(entry.tailTimer)
  entry.clock = entry.notify = entry.tailTimer = undefined
  entry.child = undefined
  entry.pid = undefined
  if (entry.artifact instanceof LiveArtifact) {
    entry.artifact.close()
  }
  entry.screen?.close()
  for (const sink of entry.sinks) {
    try {
      sink.end(reason)
    } catch {}
  }
  entry.sinks.clear()
}

export function fireListeners(entry: ShellEntry, report: ShellErrorReporter): void {
  for (const listener of entry.listeners) {
    try {
      listener()
    } catch (error) {
      report(error, { op: 'listener', sessionId: entry.info.sessionId, shellId: entry.info.id })
    }
  }
}

export function scheduleNotify(entry: ShellEntry, fire: (entry: ShellEntry) => void): void {
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

export function killTrees(entries: ShellEntry[], deps: TreeKillDeps, report: ShellErrorReporter): void {
  const live = entries.flatMap((entry) => (entry.pid === undefined ? [] : [{ entry, pid: entry.pid }]))
  if (live.length === 0) {
    return
  }
  const result = killProcessTrees(
    live.map(({ pid }) => pid),
    deps,
  )
  for (const { entry, pid } of live) {
    if (result.unreached.includes(pid)) {
      try {
        entry.child?.kill('SIGKILL')
      } catch {}
    }
    const context: ShellErrorContext = { op: 'kill', sessionId: entry.info.sessionId, shellId: entry.info.id }
    if (!result.scanned) {
      report(new Error('no process table (ps), only the process group was signalled'), context)
    } else if (result.foreign.includes(pid)) {
      report(new Error(`pid ${pid} is no longer this shell's child and was left alone`), context)
    }
  }
}

export function applyAgentWrite(entry: ShellEntry, shellId: string, enabled: boolean): boolean {
  if (enabled) {
    if (entry.info.owner !== 'user') {
      throw new Error(`shell ${shellId} was started by the agent, which may already type into it`)
    }
    if (entry.info.status !== 'running') {
      throw new Error(`shell ${shellId} has already ended; there is nothing to grant`)
    }
  }
  if ((entry.info.agentWrite === true) === enabled) {
    return false
  }
  if (enabled) {
    entry.info.agentWrite = true
  } else {
    delete entry.info.agentWrite
  }
  return true
}

export async function attachEntry(entry: ShellEntry, sink: ShellSink): Promise<ShellAttachment> {
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
}

export async function readOutput(entry: ShellEntry, query: ShellOutputQuery): Promise<string> {
  if (query.view === 'screen') {
    if (entry.screen) {
      return entry.screen.snapshot()
    }
    const replay = await entry.artifact.replay(SHELL_ATTACH_REPLAY_BYTES)
    return renderScreen(replay.toString('utf8'), entry.info.cols, entry.info.rows)
  }
  if (query.tail === undefined && query.view === 'text') {
    return entry.artifact.textView()
  }
  const raw = await entry.artifact.read(query.tail)
  const text = raw.toString('utf8')
  return query.view === 'raw' ? text : ttyText(text)
}

export function waitForChange(entry: ShellEntry | undefined, timeoutMs: number): Promise<void> {
  if (!entry || entry.info.status !== 'running') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      entry.listeners.delete(done)
      resolve()
    }
    const timer = setTimeout(done, Math.max(0, timeoutMs))
    timer.unref()
    entry.listeners.add(done)
  })
}

export function sourceFor(entry: ShellEntry, artifact: LiveArtifact): LocalShellSource {
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
