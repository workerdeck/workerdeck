import { constants as osConstants } from 'node:os'
import {
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
  TERMINAL_MIN_COLS,
  TERMINAL_MIN_ROWS,
} from '@workerdeck/protocol'
import { shellChildEnv } from './shell.ts'

const SPAWN_FAILURE_EXIT_CODE = 127
const KILLED_EXIT_CODE = 128 + osConstants.signals.SIGKILL

export type TerminalSize = { cols: number; rows: number }

export type TerminalChild = {
  write: (data: string) => void
  resize: (size: TerminalSize) => void
  kill: (reason: string) => void
}

export type SpawnTerminalInput = {
  command?: string
  cwd: string
  size: TerminalSize
  onData: (data: string) => void
  onExit: (exitCode: number, signal?: number) => void
}

type PtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ) => {
    onData: (listener: (data: string) => void) => void
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => void
    write: (data: string) => void
    resize: (cols: number, rows: number) => void
    kill: (signal?: string) => void
  }
}

let ptyModule: PtyModule | null | undefined

// The PTY backend is an optionalDependency: a gateway installed without its prebuild still runs,
// it just cannot offer terminals. Resolved once and cached, including the failure.
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

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min
}

export function clampSize(size: TerminalSize): TerminalSize {
  return {
    cols: clamp(size.cols, TERMINAL_MIN_COLS, TERMINAL_MAX_COLS),
    rows: clamp(size.rows, TERMINAL_MIN_ROWS, TERMINAL_MAX_ROWS),
  }
}

export function loginShell(env: Record<string, string | undefined>): string {
  const shell = env.SHELL
  return shell && shell.startsWith('/') ? shell : '/bin/sh'
}

export async function spawnTerminal(input: SpawnTerminalInput): Promise<TerminalChild> {
  const pty = await loadPty()
  if (!pty) {
    throw new Error('terminals are not available on this server (no pty backend installed)')
  }
  const size = clampSize(input.size)
  const shell = loginShell(process.env)
  const args = input.command ? ['-c', input.command] : ['-l']
  const env = shellChildEnv(process.env)
  env.TERM = env.TERM ?? 'xterm-256color'
  env.PWD = input.cwd
  env.COLORTERM = 'truecolor'

  let done = false
  let child: ReturnType<PtyModule['spawn']>
  const finish = (exitCode: number, signal?: number): void => {
    if (done) {
      return
    }
    done = true
    input.onExit(exitCode, signal)
  }
  try {
    child = pty.spawn(shell, args, { name: env.TERM, cols: size.cols, rows: size.rows, cwd: input.cwd, env })
  } catch (error) {
    finish(SPAWN_FAILURE_EXIT_CODE)
    throw error instanceof Error ? error : new Error('failed to spawn a terminal')
  }
  child.onData((data) => {
    if (!done) {
      input.onData(data)
    }
  })
  child.onExit(({ exitCode, signal }) => finish(exitCode, signal))

  return {
    write: (data) => {
      if (!done) {
        child.write(data)
      }
    },
    // resize on an exited pty raises EBADF from ioctl, so liveness is the guard, not a try/catch.
    resize: (next) => {
      if (done) {
        return
      }
      const clamped = clampSize(next)
      try {
        child.resize(clamped.cols, clamped.rows)
      } catch {}
    },
    kill: () => {
      if (done) {
        return
      }
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(KILLED_EXIT_CODE)
    },
  }
}
