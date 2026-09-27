import { withoutGatewaySecrets } from '@workerdeck/core'
import { SHELL_COLS, SHELL_MAX_COLS, SHELL_MAX_ROWS, SHELL_MIN_COLS, SHELL_MIN_ROWS, SHELL_ROWS } from '@workerdeck/protocol'
import type { PtyChild, PtyModule, ShellSize } from './shell-types.ts'

const TERM = 'xterm-256color'
// macOS drops a session leader's unread pty output ~600ms after it exits unless its session opened /dev/tty; the
// login shell execs under the same pid with the command as $1, so nothing is re-quoted.
const CTTY_WRAPPER = 'true <>/dev/tty 2>/dev/null; exec "$0" -c "$1"'

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

// A spawn env replaces the inherited one wholesale, so the copy has to be complete; the gateway's own environment is
// what the operator's terminal would have given the same command.
export function shellChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(withoutGatewaySecrets(base))) {
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

export function spawnShellChild(pty: PtyModule, cwd: string, command: string): PtyChild {
  const env = shellChildEnv(process.env)
  env.TERM = TERM
  env.COLORTERM = 'truecolor'
  env.PWD = cwd
  return pty.spawn('/bin/sh', ['-c', CTTY_WRAPPER, loginShell(process.env), command], {
    name: TERM,
    cols: SHELL_COLS,
    rows: SHELL_ROWS,
    cwd,
    env,
  })
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min
}
