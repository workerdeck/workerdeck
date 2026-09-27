import {
  SHELL_REFUSAL,
  agentMayWrite,
  clampShellTail,
  encodeShellKeys,
  shellOwnershipRefusal,
  shellSummary,
  shellTail,
  ttyText,
  type Runner,
  type ShellDirectory,
  type ShellReadResult,
  type ShellView,
} from '@workerdeck/core'
import { SHELL_READ_MAX_LINES, SHELL_WAIT_DEFAULT_MS, SHELL_WAIT_MAX_MS, type ShellInfo } from '@workerdeck/protocol'
import type { ShellRegistry, ShellSpawnInput } from './shell-types.ts'

// The directory reaches a live runner only to start a shell for it: the record needs the session's cwd and the runner
// draws the transcript row, exactly as a `$` from the composer does.
export type ShellDirectoryDeps = { runnerFor?: (sessionId: string) => Runner | undefined }

export type LocalCommandRunner = Runner & Required<Pick<Runner, 'queueLocalCommand'>>

type ShellSettleOptions = { view?: ShellView; tail?: number; waitFor?: string[]; timeoutMs?: number; since?: number }

type ShellTaken = { info: ShellInfo; read: Omit<ShellReadResult, 'shell' | 'wait'>; haystack: string }

// The agent's side of the same registry: a session sees its own shells and nothing else, so another session's id
// reads as missing rather than as a refusal that would name it. Writes and kills are further limited to shells the
// agent owns (`agentMayWrite`), and that refusal names the rule because the shell does exist.
export function createShellDirectory(registry: ShellRegistry, deps: ShellDirectoryDeps = {}): ShellDirectory {
  // One read of the shell as it is now. With `since`, the haystack is only what the process wrote after that byte
  // offset, so a wait that follows a keystroke cannot be satisfied by text that was already on the screen.
  const take = async (from: string, shellId: string, options: ShellSettleOptions): Promise<ShellTaken | undefined> => {
    const info = registry.get(from, shellId)
    if (!info) {
      return undefined
    }
    const view: ShellView = options.view ?? (info.interactive ? 'screen' : 'lines')
    const fresh = options.since === undefined ? undefined : await freshText(from, shellId, info.bytes - options.since)
    if (view === 'screen') {
      const text = await registry.output(from, shellId, { view: 'screen' })
      if (text === undefined) {
        return undefined
      }
      const lines = text === '' ? 0 : text.split('\n').length
      return { info, read: { view, text, lines, totalLines: lines, truncated: false }, haystack: fresh ?? text }
    }
    const text = await registry.output(from, shellId, { view: 'text' })
    if (text === undefined) {
      return undefined
    }
    return { info, read: shellTail(text, clampShellTail(options.tail)), haystack: fresh ?? shellTail(text, SHELL_READ_MAX_LINES).text }
  }
  const freshText = async (from: string, shellId: string, bytes: number): Promise<string> => {
    if (bytes <= 0) {
      return ''
    }
    const raw = await registry.output(from, shellId, { view: 'raw', tail: bytes })
    return raw === undefined ? '' : ttyText(raw)
  }
  const settle = async (from: string, shellId: string, options: ShellSettleOptions): Promise<ShellReadResult | undefined> => {
    const needles = options.waitFor ?? []
    const started = Date.now()
    const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? SHELL_WAIT_DEFAULT_MS, SHELL_WAIT_MAX_MS))
    for (;;) {
      const taken = await take(from, shellId, options)
      if (!taken) {
        return undefined
      }
      const result: ShellReadResult = { shell: shellSummary(taken.info), ...taken.read }
      if (needles.length === 0) {
        return result
      }
      const ms = Date.now() - started
      const match = needles.find((needle) => taken.haystack.includes(needle))
      if (match !== undefined) {
        return { ...result, wait: { outcome: 'matched', match, ms } }
      }
      if (taken.info.status !== 'running') {
        return { ...result, wait: { outcome: 'exited', ms } }
      }
      if (ms >= timeoutMs) {
        return { ...result, wait: { outcome: 'timeout', ms } }
      }
      await registry.changed(from, shellId, timeoutMs - ms)
    }
  }
  const writable = (from: string, shellId: string): ShellInfo | undefined => {
    const info = registry.get(from, shellId)
    if (!info) {
      return undefined
    }
    if (!agentMayWrite(info, from)) {
      throw new Error(shellOwnershipRefusal(shellId))
    }
    return info
  }
  return {
    list: async (from) => registry.list(from).map(shellSummary),
    read: (from, shellId, options) => settle(from, shellId, { ...options }),
    run: async (from, options) => {
      const runner = deps.runnerFor?.(from)
      if (!runner || !takesLocalCommands(runner)) {
        throw new Error(SHELL_REFUSAL)
      }
      const shell = await startShell(registry, { runner, command: options.command, owner: 'agent' })
      const result = await settle(from, shell.id, { waitFor: options.waitFor, timeoutMs: options.timeoutMs })
      if (!result) {
        throw new Error(`shell ${shell.id} vanished as it started`)
      }
      return result
    },
    write: async (from, shellId, options) => {
      const info = writable(from, shellId)
      if (!info) {
        return undefined
      }
      if (info.status !== 'running') {
        throw new Error(`shell ${shellId} has already ended; there is nothing to type into`)
      }
      const application = await registry.applicationCursorKeys(from, shellId)
      const data = (options.data ?? '') + encodeShellKeys(options.keys ?? [], { applicationCursorKeys: application })
      if (data.length === 0) {
        throw new Error('nothing to write: give data, keys or both')
      }
      const since = registry.get(from, shellId)?.bytes ?? info.bytes
      registry.write(from, shellId, data)
      return settle(from, shellId, { waitFor: options.waitFor, timeoutMs: options.timeoutMs, since })
    },
    kill: async (from, shellId) => {
      const info = writable(from, shellId)
      if (!info) {
        return undefined
      }
      if (info.status !== 'running') {
        return { shell: shellSummary(info), killed: false }
      }
      const killed = registry.kill(from, shellId, 'killed') ?? info
      return { shell: shellSummary(killed), killed: true }
    },
    grant: async (from, shellId) => {
      const info = registry.get(from, shellId)
      if (!info) {
        return undefined
      }
      if (info.owner === 'agent') {
        return shellSummary(info)
      }
      const granted = registry.setAgentWrite(from, shellId, true)
      return granted ? shellSummary(granted) : undefined
    },
  }
}

export function takesLocalCommands(runner: Runner): runner is LocalCommandRunner {
  return typeof runner.queueLocalCommand === 'function'
}

// queueLocalCommand throws before it pushes, so without the kill the shell would run with no transcript row.
export async function startShell(registry: ShellRegistry, input: ShellSpawnInput & { runner: LocalCommandRunner }): Promise<ShellInfo> {
  const { shell, source } = await registry.spawn(input)
  try {
    input.runner.queueLocalCommand(source)
  } catch (error) {
    registry.kill(input.runner.id, shell.id)
    throw error
  }
  return shell
}
