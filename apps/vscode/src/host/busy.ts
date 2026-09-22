import type { SessionInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'

// The same statuses `workerdeck guard` refuses to restart under.
const BUSY_STATUSES = new Set(['starting', 'running', 'awaiting_approval'])

const MAX_NAMED = 5

export type BusySummary = {
  busy: number
  awaiting: number
  names: string[]
  shells: number
  shellNames: string[]
}

export function summarizeBusy(sessions: readonly SessionInfo[]): BusySummary {
  const busy = sessions.filter((s) => BUSY_STATUSES.has(s.status) || s.pendingPermissionCount > 0)
  const shells = sessions.flatMap((s) => (s.shells ?? []).filter((shell) => shell.status === 'running'))
  return {
    busy: busy.length,
    awaiting: busy.filter((s) => s.status === 'awaiting_approval' || s.pendingPermissionCount > 0).length,
    names: busy.slice(0, MAX_NAMED).map((s) => s.title ?? s.id.slice(0, 8)),
    shells: shells.length,
    shellNames: shells.slice(0, MAX_NAMED).map((shell) => shell.label || shell.command.split('\n')[0] || shell.id.slice(0, 8)),
  }
}

export async function confirmDisruption(verb: 'Stop' | 'Restart', summary: BusySummary): Promise<boolean> {
  if (summary.busy === 0 && summary.shells === 0) {
    return true
  }
  const answer = await vscode.window.showWarningMessage(
    headline(verb, summary),
    { modal: true, detail: detailOf(summary) },
    `${verb} anyway`,
  )
  return answer === `${verb} anyway`
}

function headline(verb: 'Stop' | 'Restart', summary: BusySummary): string {
  const parts: string[] = []
  if (summary.busy > 0) {
    parts.push(`${summary.busy} session${summary.busy === 1 ? ' is' : 's are'} still working`)
  }
  if (summary.shells > 0) {
    parts.push(`${summary.shells} shell${summary.shells === 1 ? ' is' : 's are'} still running`)
  }
  return `${verb} the WorkerDeck server? ${parts.join(' and ')}.`
}

function detailOf(summary: BusySummary): string {
  const lines: string[] = []
  if (summary.busy > 0) {
    lines.push(`${listOf(summary.names, summary.busy)}.`)
  }
  if (summary.awaiting > 0) {
    lines.push(`${summary.awaiting} of them ${summary.awaiting === 1 ? 'is' : 'are'} waiting for you to answer a permission prompt.`)
  }
  if (summary.shells > 0) {
    lines.push(`Shells that will be killed: ${listOf(summary.shellNames, summary.shells)}.`)
  }
  lines.push('Parked sessions are restored on the next start; a turn in flight is not.')
  return lines.join('\n\n')
}

function listOf(names: readonly string[], total: number): string {
  const more = total > names.length ? `, and ${total - names.length} more` : ''
  return `${names.join(', ')}${more}`
}
