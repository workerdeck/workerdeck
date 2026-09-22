import { describe, expect, it } from 'vitest'
import { killProcessTrees, parseProcessTable, type ProcessRow, type ProcessSignal } from '../src/services/process-tree.ts'

const SELF = 500
const SELF_PGID = 400
const ROOT = 1000

const INIT: ProcessRow = { pid: 1, ppid: 0, pgid: 1 }
const ME: ProcessRow = { pid: SELF, ppid: 300, pgid: SELF_PGID }
const LEADER: ProcessRow = { pid: ROOT, ppid: SELF, pgid: ROOT }

type Sent = { pid: number; name: ProcessSignal }

function recorder(failing: number[] = []) {
  const sent: Sent[] = []
  const signal = (pid: number, name: ProcessSignal): void => {
    sent.push({ pid, name })
    if (failing.includes(pid)) {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }
  }
  const of = (name: ProcessSignal): number[] => sent.filter((s) => s.name === name).map((s) => s.pid)
  const pids = (): number[] => sent.map((s) => s.pid)
  return { sent, signal, of, pids }
}

function tableOf(...snapshots: ProcessRow[][]) {
  let calls = 0
  const table = (): ProcessRow[] => {
    const snapshot = snapshots[Math.min(calls, snapshots.length - 1)]!
    calls++
    return snapshot
  }
  return { table, calls: () => calls }
}

describe('parseProcessTable', () => {
  it('reads pid, ppid and pgid per line and skips headers and noise', () => {
    const text = '  PID  PPID  PGID\n    1     0     1\n  200   1   200\n\nbogus line here\n 300 200 x\n'
    expect(parseProcessTable(text)).toEqual([
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: 200, ppid: 1, pgid: 200 },
    ])
  })
})

describe('killProcessTrees', () => {
  it('freezes the closure, kills every descendant by pid and every group it observed', () => {
    const child: ProcessRow = { pid: 1001, ppid: ROOT, pgid: ROOT }
    const escapee: ProcessRow = { pid: 1002, ppid: 1001, pgid: 1002 }
    const unrelated: ProcessRow = { pid: 2000, ppid: 1, pgid: 2000 }
    const { table, calls } = tableOf([INIT, ME, LEADER, child, escapee, unrelated])
    const rec = recorder()
    const result = killProcessTrees([ROOT], { table, signal: rec.signal, self: SELF })
    expect(result).toEqual({ scanned: true, descendants: 2, foreign: [], unreached: [] })
    expect(rec.of('SIGSTOP')).toEqual([-ROOT, 1001, 1002])
    expect(rec.of('SIGKILL')).toEqual([-ROOT, 1001, 1002, -1002])
    expect(rec.pids()).not.toContain(2000)
    expect(calls()).toBe(2)
    for (const stop of rec.of('SIGSTOP')) {
      expect(rec.of('SIGKILL')).toContain(stop)
    }
  })

  it('never signals the gateway, pid 1, the broadcast group or the gateway group, whatever the table claims', () => {
    const rows: ProcessRow[] = [
      INIT,
      ME,
      LEADER,
      { pid: 1, ppid: ROOT, pgid: 1 },
      { pid: SELF, ppid: ROOT, pgid: SELF_PGID },
      { pid: 0, ppid: ROOT, pgid: 0 },
      { pid: 1003, ppid: ROOT, pgid: SELF_PGID },
      { pid: 1004, ppid: ROOT, pgid: 1 },
      { pid: 1005, ppid: ROOT, pgid: SELF },
    ]
    const rec = recorder()
    killProcessTrees([ROOT, 0, 1, SELF, -7, Number.NaN], { table: tableOf(rows).table, signal: rec.signal, self: SELF })
    expect(rec.of('SIGKILL')).toEqual([-ROOT, 1003, 1004, 1005])
    for (const forbidden of [0, 1, -1, SELF, -SELF, SELF_PGID, -SELF_PGID, -7, 7]) {
      expect(rec.pids()).not.toContain(forbidden)
    }
  })

  it('never sends the broadcast kill when the gateway itself is pid 1', () => {
    const rows: ProcessRow[] = [
      { pid: 1, ppid: 0, pgid: 1 },
      { pid: ROOT, ppid: 1, pgid: ROOT },
      { pid: 1001, ppid: ROOT, pgid: 1 },
    ]
    const rec = recorder()
    killProcessTrees([ROOT], { table: tableOf(rows).table, signal: rec.signal, self: 1 })
    expect(rec.of('SIGKILL')).toEqual([-ROOT, 1001])
    expect(rec.pids()).not.toContain(-1)
    expect(rec.pids()).not.toContain(1)
  })

  it('leaves a root alone entirely when the table shows it under another parent', () => {
    const recycled: ProcessRow = { pid: ROOT, ppid: 777, pgid: ROOT }
    const orphan: ProcessRow = { pid: 1001, ppid: ROOT, pgid: ROOT }
    const rec = recorder()
    const result = killProcessTrees([ROOT], { table: tableOf([INIT, ME, recycled, orphan]).table, signal: rec.signal, self: SELF })
    expect(result).toEqual({ scanned: true, descendants: 0, foreign: [ROOT], unreached: [] })
    expect(rec.sent).toEqual([])
  })

  it('kills only the group of a root that is already gone from the table', () => {
    const rec = recorder()
    const result = killProcessTrees([ROOT], { table: tableOf([INIT, ME]).table, signal: rec.signal, self: SELF })
    expect(result).toEqual({ scanned: true, descendants: 0, foreign: [], unreached: [] })
    expect(rec.sent).toEqual([{ pid: -ROOT, name: 'SIGKILL' }])
  })

  it('falls back to the group kill alone without a table, and reports the group it could not reach', () => {
    for (const table of [
      () => null,
      () => {
        throw new Error('no ps')
      },
    ]) {
      const rec = recorder([-ROOT])
      const result = killProcessTrees([ROOT, 1100], { table, signal: rec.signal, self: SELF })
      expect(result).toEqual({ scanned: false, descendants: 0, foreign: [], unreached: [ROOT] })
      expect(rec.sent).toEqual([
        { pid: -ROOT, name: 'SIGKILL' },
        { pid: -1100, name: 'SIGKILL' },
      ])
    }
  })

  it('rescans until the closure stops growing, so a fork between the scan and the freeze is caught', () => {
    const child: ProcessRow = { pid: 1001, ppid: ROOT, pgid: ROOT }
    const late: ProcessRow = { pid: 1002, ppid: 1001, pgid: 1002 }
    const later: ProcessRow = { pid: 1003, ppid: 1002, pgid: 1002 }
    const { table, calls } = tableOf([INIT, ME, LEADER, child], [INIT, ME, LEADER, child, late], [INIT, ME, LEADER, child, late, later])
    const rec = recorder()
    const result = killProcessTrees([ROOT], { table, signal: rec.signal, self: SELF })
    expect(result.descendants).toBe(3)
    expect(calls()).toBe(4)
    expect(rec.of('SIGSTOP')).toEqual([-ROOT, 1001, 1002, 1003])
    expect(rec.of('SIGKILL')).toEqual([-ROOT, 1001, 1002, 1003, -1002])
  })

  it('bounds the rescans against a tree that never stops growing', () => {
    let next = 1001
    let calls = 0
    const rows: ProcessRow[] = [INIT, ME, LEADER]
    const table = (): ProcessRow[] => {
      calls++
      rows.push({ pid: next, ppid: next === 1001 ? ROOT : next - 1, pgid: ROOT })
      next++
      return [...rows]
    }
    const rec = recorder()
    const result = killProcessTrees([ROOT], { table, signal: rec.signal, self: SELF })
    expect(calls).toBe(5)
    expect(result.descendants).toBe(5)
    expect(rec.of('SIGKILL')).toEqual([-ROOT, 1001, 1002, 1003, 1004, 1005])
  })

  it('swallows a failed descendant signal and handles several roots in one pass', () => {
    const other = 3000
    const rows: ProcessRow[] = [
      INIT,
      ME,
      LEADER,
      { pid: other, ppid: SELF, pgid: other },
      { pid: 1001, ppid: ROOT, pgid: other },
      { pid: 3001, ppid: other, pgid: 3001 },
      { pid: 3002, ppid: other, pgid: 3001 },
    ]
    const { table, calls } = tableOf(rows)
    const rec = recorder([1001, 3002])
    const result = killProcessTrees([ROOT, other], { table, signal: rec.signal, self: SELF })
    expect(result).toEqual({ scanned: true, descendants: 3, foreign: [], unreached: [] })
    expect(calls()).toBe(2)
    expect(rec.of('SIGKILL')).toEqual([-ROOT, -other, 1001, 3001, 3002, -3001])
  })
})
