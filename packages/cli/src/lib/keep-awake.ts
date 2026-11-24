import { spawn, type ChildProcess } from 'node:child_process'
import { holdsAwake, wakeHolders, type SessionInfo, type ShellInfo } from '@workerdeck/protocol'

const WAKE_EVENTS = new Set(['status_changed', 'session_closed', 'session_error'])

export type WakeLock = {
  readonly held: boolean
  readonly available: boolean
  set: (wanted: boolean) => void
  release: () => void
}

// `wakeHolders`: a turn in flight or a running `keepAwake` shell. Not an approval wait, unlike `guard`'s busy set: no
// model request is open while a session waits on a person, so a sleep suspends it without costing the turn.
// The registry's infos carry no shells, so the shell registry's running ones are passed beside them.
export function sessionsNeedTheMachine(sessions: readonly SessionInfo[], shells: readonly ShellInfo[] = []): boolean {
  return holdsAwake(wakeHolders(sessions)) || shells.some((shell) => shell.keepAwake && shell.status === 'running')
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
  shells?: () => ShellInfo[]
  observe: (
    listener: (runner: {
      subscribe: (listener: (event: { type: string }) => void, afterSeq?: number) => unknown
      info: () => SessionInfo
    }) => void,
  ) => unknown
}

// Recomputed from the registry rather than counted up and down. A refcount has to be decremented on every exit path
// a session can take - closed, failed, parked, evicted, drained - and one missed path pins the machine awake until
// the gateway stops. Derived state cannot leak that way, so the sweep below is insurance, not the mechanism.
export function driveWakeLock(source: WakeSource, lock: Pick<WakeLock, 'set'>): void {
  const sync = (): void => lock.set(sessionsNeedTheMachine(source.list(), source.shells?.()))
  source.observe((runner) =>
    // Handed back, not dropped: a runner carried to another generation by a hot reload would otherwise keep
    // syncing a lock that belongs to a process state this observer no longer describes.
    runner.subscribe((event) => {
      if (WAKE_EVENTS.has(event.type)) {
        sync()
      }
    }, runner.info().lastSeq),
  )
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
    // A missing binary is not an error - a box with neither tool must start and run normally - but stop trying.
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
    get available(): boolean {
      return available
    },
    set: (wanted) => (wanted ? start() : stop()),
    release: stop,
  }
}
