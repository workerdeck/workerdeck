import type { SessionInfo } from '@workerdeck/protocol'
import * as vscode from 'vscode'

// The same statuses `workerdeck guard` refuses to restart under.
const BUSY_STATUSES = new Set(['starting', 'running', 'awaiting_approval'])

const MAX_NAMED = 5

export type BusySummary = {
  busy: number
  awaiting: number
  names: string[]
}

export function summarizeBusy(sessions: readonly SessionInfo[]): BusySummary {
  const busy = sessions.filter((s) => BUSY_STATUSES.has(s.status) || s.pendingPermissionCount > 0)
  return {
    busy: busy.length,
    awaiting: busy.filter((s) => s.status === 'awaiting_approval' || s.pendingPermissionCount > 0).length,
    names: busy.slice(0, MAX_NAMED).map((s) => s.title ?? s.id.slice(0, 8)),
  }
}

export async function confirmDisruption(verb: 'Stop' | 'Restart', summary: BusySummary): Promise<boolean> {
  if (summary.busy === 0) {
    return true
  }
  const listed = summary.names.join(', ')
  const more = summary.busy > summary.names.length ? `, and ${summary.busy - summary.names.length} more` : ''
  const awaiting =
    summary.awaiting > 0
      ? `\n\n${summary.awaiting} of them ${summary.awaiting === 1 ? 'is' : 'are'} waiting for you to answer a permission prompt.`
      : ''
  const answer = await vscode.window.showWarningMessage(
    `${verb} the WorkerDeck server? ${summary.busy} session${summary.busy === 1 ? ' is' : 's are'} still working.`,
    {
      modal: true,
      detail: `${listed}${more}.${awaiting}\n\nParked sessions are restored on the next start; a turn in flight is not.`,
    },
    `${verb} anyway`,
  )
  return answer === `${verb} anyway`
}
