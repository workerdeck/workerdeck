import { spawnSync } from 'node:child_process'

export type ProcessRow = { pid: number; ppid: number; pgid: number }

export type ProcessTable = () => ProcessRow[] | null

export type ProcessSignal = 'SIGSTOP' | 'SIGKILL'

export type TreeKillDeps = { table: ProcessTable; signal: (pid: number, signal: ProcessSignal) => void; self: number }

export type TreeKillResult = { scanned: boolean; descendants: number; foreign: number[]; unreached: number[] }

const PS_ARGS = ['-eo', 'pid=,ppid=,pgid=']
const PS_TIMEOUT_MS = 2000
const PS_MAX_BUFFER = 64 * 1024 * 1024
const MAX_ROUNDS = 5

export function readProcessTable(): ProcessRow[] | null {
  const result = spawnSync('ps', PS_ARGS, {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
    maxBuffer: PS_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return null
  }
  return parseProcessTable(result.stdout)
}

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/)
    if (fields.length !== 3) {
      continue
    }
    const [pid, ppid, pgid] = fields.map(Number) as [number, number, number]
    if (Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(pgid)) {
      rows.push({ pid, ppid, pgid })
    }
  }
  return rows
}

// Freezes the tree under each root before killing it, so nothing discovered can fork past the scan: scan, SIGSTOP what
// the scan found, rescan until the closure stops growing, then SIGKILL the closure. A root the table shows under a
// parent other than us is a recycled pid and is not signalled at all. Without a table it is the group kill alone.
export function killProcessTrees(roots: number[], deps: TreeKillDeps): TreeKillResult {
  const { self } = deps
  const signal = (pid: number, name: ProcessSignal): boolean => {
    try {
      deps.signal(pid, name)
      return true
    } catch {
      return false
    }
  }
  const owned = (pid: number): boolean => Number.isInteger(pid) && pid > 1 && pid !== self
  const live = new Set(roots.filter(owned))
  const closure = new Map<number, ProcessRow>()
  const rootRows = new Map<number, ProcessRow>()
  const foreign: number[] = []
  let scanned = false
  let selfPgid: number | undefined
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const table = readTable(deps.table)
    if (table === null) {
      break
    }
    const byPid = new Map<number, ProcessRow>()
    const byParent = new Map<number, ProcessRow[]>()
    for (const row of table) {
      byPid.set(row.pid, row)
      const siblings = byParent.get(row.ppid)
      if (siblings) {
        siblings.push(row)
      } else {
        byParent.set(row.ppid, [row])
      }
    }
    let grew = false
    if (!scanned) {
      scanned = true
      selfPgid = byPid.get(self)?.pgid
      for (const root of live) {
        const row = byPid.get(root)
        if (row === undefined) {
          continue
        }
        if (row.ppid !== self) {
          foreign.push(root)
          live.delete(root)
          continue
        }
        rootRows.set(root, row)
        signal(-root, 'SIGSTOP')
        // The roots were scanned before they were frozen, so the first round always earns a rescan.
        grew = true
      }
    }
    for (const root of rootRows.keys()) {
      const queue = [root]
      const seen = new Set<number>([root])
      while (queue.length > 0) {
        const parent = queue.shift()!
        for (const child of byParent.get(parent) ?? []) {
          if (!owned(child.pid) || seen.has(child.pid)) {
            continue
          }
          seen.add(child.pid)
          queue.push(child.pid)
          if (!closure.has(child.pid)) {
            closure.set(child.pid, child)
            signal(child.pid, 'SIGSTOP')
            grew = true
          }
        }
      }
    }
    if (!grew) {
      break
    }
  }
  const unreached: number[] = []
  const groups = new Set<number>()
  for (const root of live) {
    groups.add(root)
    if (!signal(-root, 'SIGKILL')) {
      unreached.push(root)
    }
  }
  for (const pid of closure.keys()) {
    signal(pid, 'SIGKILL')
  }
  if (selfPgid !== undefined) {
    for (const row of [...rootRows.values(), ...closure.values()]) {
      const group = row.pgid
      if (group <= 1 || group === self || group === selfPgid || groups.has(group)) {
        continue
      }
      groups.add(group)
      signal(-group, 'SIGKILL')
    }
  }
  return { scanned, descendants: closure.size, foreign, unreached }
}

function readTable(table: ProcessTable): ProcessRow[] | null {
  try {
    return table()
  } catch {
    return null
  }
}
