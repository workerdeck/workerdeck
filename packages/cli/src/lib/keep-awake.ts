import { spawn, type ChildProcess } from 'node:child_process'
import type { SessionInfo } from '@workerdeck/protocol'

// The states that are waiting on this machine: a turn in flight, and a session blocked on the operator, who is
// coming back to it and would find the socket gone. Deliberately the same set `workerdeck guard` calls busy.
const AWAKE_STATUSES = new Set<SessionInfo['status']>(['starting', 'running', 'awaiting_approval'])

export type WakeLock = {
  readonly held: boolean
  set: (wanted: boolean) => void
  release: () => void
}

export function sessionsNeedTheMachine(sessions: readonly SessionInfo[]): boolean {
  return sessions.some((session) => AWAKE_STATUSES.has(session.status))
}

// Both platforms hold the lock for as long as a child process lives, and both tie that child's life to *this* pid
// rather than to a kill we might never get to make: `caffeinate -w` waits on a pid, and the inhibited command polls
// one. So a SIGKILLed gateway releases within seconds instead of pinning the machine awake until reboot.
function lockCommand(pid: number): { command: string; args: string[] } | null {
  if (process.platform === 'darwin') {
    // -i is idle sleep only. Never -d: keeping the screen lit is not what was asked for.
    return { command: 'caffeinate', args: ['-i', '-w', String(pid)] }
  }
  if (process.platform === 'linux') {
    return {
      command: 'systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--mode=block',
        '--who=workerdeck',
        '--why=a turn is running',
        'sh',
        '-c',
        `while kill -0 ${pid} 2>/dev/null; do sleep 5; done`,
      ],
    }
  }
  return null
}

export type WakeSource = {
  list: () => SessionInfo[]
  observe: (
    listener: (runner: {
      subscribe: (listener: (event: { type: string }) => void, afterSeq?: number) => unknown
      info: () => SessionInfo
    }) => void,
  ) => unknown
}

// Recomputed from the registry rather than counted up and down. A refcount has to be decremented on every exit path
// a session can take — closed, failed, parked, evicted, drained — and one missed path pins the machine awake until
// the gateway stops. Derived state cannot leak that way, so the sweep below is insurance, not the mechanism.
export function driveWakeLock(source: WakeSource, lock: Pick<WakeLock, 'set'>): void {
  const sync = (): void => lock.set(sessionsNeedTheMachine(source.list()))
  source.observe((runner) => {
    runner.subscribe((event) => {
      if (event.type === 'status_changed' || event.type === 'session_closed' || event.type === 'session_error') {
        sync()
      }
    }, runner.info().lastSeq)
  })
  sync()
}

export function createWakeLock(options: { pid?: number; onUnavailable?: (reason: string) => void } = {}): WakeLock {
  const plan = lockCommand(options.pid ?? process.pid)
  let child: ChildProcess | null = null
  let available = plan !== null

  const stop = (): void => {
    const running = child
    child = null
    running?.kill()
  }

  const start = (): void => {
    if (!plan || !available || child) {
      return
    }
    let spawned: ChildProcess
    try {
      spawned = spawn(plan.command, plan.args, { stdio: 'ignore' })
    } catch {
      available = false
      options.onUnavailable?.(`could not spawn ${plan.command}`)
      return
    }
    child = spawned
    // A missing binary is not an error — a box with neither tool must start and run normally — but stop trying.
    spawned.on('error', () => {
      if (child === spawned) {
        child = null
      }
      available = false
      options.onUnavailable?.(`${plan.command} is not available on this machine`)
    })
    spawned.on('exit', () => {
      if (child === spawned) {
        child = null
      }
    })
    // Never the reason the gateway cannot exit.
    spawned.unref()
  }

  return {
    get held(): boolean {
      return child !== null
    },
    set: (wanted) => (wanted ? start() : stop()),
    release: stop,
  }
}
