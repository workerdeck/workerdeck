import type { SessionInfo, ShellInfo } from './index.ts'

export type WakeHolders = { turns: number; shells: ShellInfo[] }

// What keeps a gateway's machine awake: a turn in flight, and a running shell marked `keepAwake`. A session waiting on
// an approval does not: no model request is open while it waits, so a sleep suspends it without costing the turn.
export function wakeHolders(sessions: readonly SessionInfo[]): WakeHolders {
  let turns = 0
  const shells: ShellInfo[] = []
  for (const session of sessions) {
    if (session.status === 'starting' || session.status === 'running') {
      turns++
    }
    for (const shell of session.shells ?? []) {
      if (shell.keepAwake && shell.status === 'running') {
        shells.push(shell)
      }
    }
  }
  return { turns, shells }
}

export function holdsAwake(holders: WakeHolders): boolean {
  return holders.turns > 0 || holders.shells.length > 0
}

export function wakeSummary(holders: WakeHolders, machine = 'this machine', always = false): string | undefined {
  if (always) {
    return `Keeping ${machine} awake: always on`
  }
  const parts = [
    holders.turns ? `${holders.turns} turn${holders.turns === 1 ? '' : 's'}` : '',
    holders.shells.length ? `${holders.shells.length} shell${holders.shells.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean)
  return parts.length ? `Keeping ${machine} awake: ${parts.join(', ')}` : undefined
}
