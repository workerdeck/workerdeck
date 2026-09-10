import { spawn } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import type { Runner } from '@workerdeck/core'
import { ENGINE_CAPABILITIES } from '@workerdeck/protocol'

export const SHELL_DEFAULT_TIMEOUT_MS = 120_000
export const SHELL_DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024
const TIMEOUT_EXIT_CODE = 124
const SPAWN_FAILURE_EXIT_CODE = 127
const KILLED_EXIT_CODE = 128 + osConstants.signals.SIGKILL

export type ShellServiceOptions = {
  timeoutMs?: number
  maxOutputBytes?: number
}

export type ShellRunResult = {
  command: string
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export type ShellChild = {
  result: Promise<ShellRunResult>
  kill: (reason: string) => void
}

export type ShellService = ReturnType<typeof createShellService>

export function shellPermitted(shell: ShellService | null, runner: Runner, operator: boolean): boolean {
  if (shell === null || !operator) {
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

export function createShellService(options: ShellServiceOptions = {}) {
  const timeoutMs = options.timeoutMs ?? SHELL_DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? SHELL_DEFAULT_MAX_OUTPUT_BYTES
  const active = new Map<string, ShellChild>()

  const run = async (sessionId: string, cwd: string, command: string): Promise<ShellRunResult> => {
    if (active.has(sessionId)) {
      throw new Error('a shell command is still running on this session')
    }
    const child = spawnShell({ command, cwd, env: shellChildEnv(process.env), timeoutMs, maxOutputBytes })
    active.set(sessionId, child)
    try {
      return await child.result
    } finally {
      if (active.get(sessionId) === child) {
        active.delete(sessionId)
      }
    }
  }

  const kill = (sessionId: string, reason = 'session closed'): void => {
    active.get(sessionId)?.kill(reason)
  }

  const watch = (runner: Runner): (() => void) =>
    runner.subscribe((event) => {
      if (event.type === 'session_closed') {
        kill(runner.id, 'session closed')
      } else if (event.type === 'status_changed' && event.status === 'parked') {
        kill(runner.id, 'session parked')
      }
    }, runner.info().lastSeq)

  const killAll = (): void => {
    for (const sessionId of active.keys()) {
      kill(sessionId, 'server shutting down')
    }
  }

  const running = (sessionId: string): boolean => active.has(sessionId)

  return { run, kill, watch, killAll, running, timeoutMs, maxOutputBytes }
}

type SpawnShellInput = {
  command: string
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  maxOutputBytes: number
}

class BoundedOutput {
  #chunks: Buffer[] = []
  #kept = 0
  #dropped = 0
  #budget: { remaining: number }

  constructor(budget: { remaining: number }) {
    this.#budget = budget
  }

  push(chunk: Buffer): void {
    const take = Math.min(chunk.length, this.#budget.remaining)
    if (take > 0) {
      this.#chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take))
      this.#kept += take
      this.#budget.remaining -= take
    }
    this.#dropped += chunk.length - take
  }

  text(): string {
    const head = Buffer.concat(this.#chunks, this.#kept).toString('utf8')
    return this.#dropped > 0 ? `${head}\n[output truncated: ${this.#dropped} more bytes dropped]` : head
  }
}

export function spawnShell(input: SpawnShellInput): ShellChild {
  const startedAt = Date.now()
  const budget = { remaining: input.maxOutputBytes }
  const stdout = new BoundedOutput(budget)
  const stderr = new BoundedOutput(budget)
  let settle: ((result: ShellRunResult) => void) | undefined
  const result = new Promise<ShellRunResult>((resolve) => {
    settle = resolve
  })
  let done = false
  const finish = (exitCode: number, note?: string): void => {
    if (done) {
      return
    }
    done = true
    clearTimeout(timer)
    const captured = stderr.text()
    const stderrText = note ? (captured ? `${captured}\n[${note}]` : `[${note}]`) : captured
    settle?.({ command: input.command, stdout: stdout.text(), stderr: stderrText, exitCode, durationMs: Date.now() - startedAt })
  }

  // The child leads its own process group so a kill reaches the pipeline it started, not just the shell.
  const child = spawn('/bin/sh', ['-c', input.command], {
    cwd: input.cwd,
    env: { ...input.env, PWD: input.cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

  const killGroup = (): void => {
    if (child.pid === undefined) {
      return
    }
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    child.stdout.destroy()
    child.stderr.destroy()
  }
  const kill = (reason: string, exitCode = KILLED_EXIT_CODE): void => {
    if (done) {
      return
    }
    killGroup()
    finish(exitCode, `killed: ${reason}`)
  }

  const timer = setTimeout(() => kill(`timed out after ${Math.round(input.timeoutMs / 1000)}s`, TIMEOUT_EXIT_CODE), input.timeoutMs)
  child.on('error', (error) => finish(SPAWN_FAILURE_EXIT_CODE, error.message))
  child.on('close', (code, signal) => {
    const signalCode = signal ? (osConstants.signals[signal] ?? 0) : 0
    finish(code ?? (signalCode ? 128 + signalCode : 1), signal ? `killed by ${signal}` : undefined)
  })

  return { result, kill: (reason) => kill(reason) }
}
