import { wakeHolders, wakeSummary, type SessionInfo } from '@workerdeck/protocol'
import { describe, expect, it } from 'vitest'
import { ConfigError, parseArgs, resolveInstanceConfig } from '../src/config.ts'
import { createWakeLock, driveWakeLock, sessionsNeedTheMachine } from '../src/lib/keep-awake.ts'

const noConfig = { path: null, options: {} }

function session(status: SessionInfo['status']): SessionInfo {
  return { id: status, status } as SessionInfo
}

describe('sessionsNeedTheMachine', () => {
  it('holds while a turn is in flight', () => {
    for (const status of ['starting', 'running'] as const) {
      expect(sessionsNeedTheMachine([session(status)])).toBe(true)
    }
  })

  it('releases for a session waiting on an approval, and every state with no turn in flight', () => {
    for (const status of ['awaiting_approval', 'idle', 'parked', 'failed', 'closed'] as const) {
      expect(sessionsNeedTheMachine([session(status)])).toBe(false)
    }
    expect(sessionsNeedTheMachine([])).toBe(false)
  })

  it('holds for a running keep-awake shell on an idle session, not for an ended one or one without the flag', () => {
    const shell = (status: 'running' | 'exited', keepAwake?: boolean) => ({ id: 'sh', status, ...(keepAwake ? { keepAwake } : {}) })
    const idle = (shells: object[]) => ({ ...session('idle'), shells }) as SessionInfo
    expect(sessionsNeedTheMachine([idle([shell('running', true)])])).toBe(true)
    expect(sessionsNeedTheMachine([idle([shell('exited', true)])])).toBe(false)
    expect(sessionsNeedTheMachine([idle([shell('running')])])).toBe(false)
  })

  it('summarises what holds, and nothing when nothing does', () => {
    const shells = [{ id: 'sh', label: 'build', status: 'running', keepAwake: true }]
    const sessions = [session('running'), session('starting'), { ...session('idle'), shells } as SessionInfo]
    expect(wakeSummary(wakeHolders(sessions))).toBe('Keeping this machine awake: 2 turns, 1 shell')
    expect(wakeSummary(wakeHolders([session('running')]), 'mac')).toBe('Keeping mac awake: 1 turn')
    expect(wakeSummary(wakeHolders([session('awaiting_approval')]))).toBeUndefined()
    expect(wakeSummary(wakeHolders([]), 'mini', true)).toBe('Keeping mini awake: always on')
  })

  it('holds while any one session needs it, not only the first', () => {
    expect(sessionsNeedTheMachine([session('idle'), session('closed'), session('running')])).toBe(true)
  })
})

describe('createWakeLock', () => {
  // Watching a pid that has already exited: the child dies immediately, so the lifecycle is exercised without
  // holding a real assertion on the machine running the suite.
  const deadPid = 0x7fffffff

  it('is a no-op that never claims to hold on a platform with no inhibitor', () => {
    if (process.platform === 'darwin' || process.platform === 'linux') {
      return
    }
    const lock = createWakeLock({ pid: deadPid })
    lock.set(true)
    expect(lock.held).toBe(false)
  })

  it('holds once and releases to nothing, and a repeated set does not stack children', () => {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return
    }
    const lock = createWakeLock({ pid: deadPid })
    lock.set(true)
    expect(lock.held).toBe(true)
    lock.set(true)
    expect(lock.held).toBe(true)
    lock.set(false)
    expect(lock.held).toBe(false)
    lock.release()
    expect(lock.held).toBe(false)
  })
})

describe('driveWakeLock', () => {
  function fakeSource() {
    const sessions: SessionInfo[] = []
    const emitters: Array<(event: { type: string }) => void> = []
    return {
      sessions,
      emit: (type: string) => {
        for (const listener of emitters) {
          listener({ type })
        }
      },
      list: () => sessions,
      observe: (listener: (runner: { subscribe: (l: (e: { type: string }) => void) => unknown; info: () => SessionInfo }) => void) => {
        listener({
          subscribe: (l) => void emitters.push(l),
          info: () => session('idle'),
        })
      },
    }
  }

  it('syncs on first drive, before any event has arrived', () => {
    const source = fakeSource()
    source.sessions.push(session('running'))
    const seen: boolean[] = []
    driveWakeLock(source, { set: (v) => void seen.push(v) })
    expect(seen).toEqual([true])
  })

  it('follows the registry rather than counting, so a session vanishing releases', () => {
    const source = fakeSource()
    const seen: boolean[] = []
    driveWakeLock(source, { set: (v) => void seen.push(v) })
    expect(seen.at(-1)).toBe(false)

    source.sessions.push(session('running'))
    source.emit('status_changed')
    expect(seen.at(-1)).toBe(true)

    // Removed from the registry with no release of its own - the recompute is what frees the machine.
    source.sessions.length = 0
    source.emit('session_closed')
    expect(seen.at(-1)).toBe(false)
  })

  it('ignores the traffic of a turn - only transitions recompute', () => {
    const source = fakeSource()
    const seen: boolean[] = []
    driveWakeLock(source, { set: (v) => void seen.push(v) })
    const before = seen.length
    for (const type of ['stream_delta', 'assistant_message', 'context_usage', 'turn_result']) {
      source.emit(type)
    }
    expect(seen.length).toBe(before)
  })
})

describe('the keep-awake flag', () => {
  it('is on by default, off with --no-keep-awake, and takes the config file only when the flag is absent', () => {
    const fileOff = { path: null, options: { keepAwake: false } }
    const fileOn = { path: null, options: { keepAwake: true } }
    const rows = [
      ['default', [], noConfig, true],
      ['flag', ['--no-keep-awake'], noConfig, false],
      ['config off, no flag', [], fileOff, false],
      ['config on, flag off', ['--no-keep-awake'], fileOn, false],
      ['flag always', ['--keep-awake', 'always'], noConfig, 'always'],
      ['config always', [], { path: null, options: { keepAwake: 'always' } }, 'always'],
      ['config always, flag work', ['--keep-awake', 'work'], { path: null, options: { keepAwake: 'always' } }, true],
      ['config on, flag off by name', ['--keep-awake', 'off'], fileOn, false],
    ] as const
    expect(rows.map(([label, argv, file]) => [label, resolveInstanceConfig(parseArgs([...argv]), file).keepAwake])).toEqual(
      rows.map(([label, , , expected]) => [label, expected]),
    )
  })

  it('refuses a mode it does not know, from the flag or the config file', () => {
    expect(() => parseArgs(['--keep-awake', 'forever'])).toThrow(ConfigError)
    const file = { path: null, options: { keepAwake: 'forever' as never } }
    expect(() => resolveInstanceConfig(parseArgs([]), file)).toThrow(/config keepAwake/)
  })

  it('is not passed through to the server, which owns no power policy', () => {
    const resolved = resolveInstanceConfig(parseArgs([]), noConfig)
    expect('keepAwake' in resolved.options).toBe(false)
  })
})
