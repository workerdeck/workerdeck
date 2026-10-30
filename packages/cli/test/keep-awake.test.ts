import type { SessionInfo } from '@workerdeck/protocol'
import { describe, expect, it } from 'vitest'
import { parseArgs, resolveInstanceConfig } from '../src/config.ts'
import { createWakeLock, driveWakeLock, sessionsNeedTheMachine } from '../src/lib/keep-awake.ts'

const noConfig = { path: null, options: {} }

function session(status: SessionInfo['status']): SessionInfo {
  return { id: status, status } as SessionInfo
}

describe('sessionsNeedTheMachine', () => {
  it('holds while a turn is in flight or a session is blocked on a human', () => {
    for (const status of ['starting', 'running', 'awaiting_approval'] as const) {
      expect(sessionsNeedTheMachine([session(status)])).toBe(true)
    }
  })

  it('releases for every state that is not waiting on this machine', () => {
    for (const status of ['idle', 'parked', 'failed', 'closed'] as const) {
      expect(sessionsNeedTheMachine([session(status)])).toBe(false)
    }
    expect(sessionsNeedTheMachine([])).toBe(false)
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
    ] as const
    expect(rows.map(([label, argv, file]) => [label, resolveInstanceConfig(parseArgs([...argv]), file).keepAwake])).toEqual(
      rows.map(([label, , , expected]) => [label, expected]),
    )
  })

  it('is not passed through to the server, which owns no power policy', () => {
    const resolved = resolveInstanceConfig(parseArgs([]), noConfig)
    expect('keepAwake' in resolved.options).toBe(false)
  })
})
