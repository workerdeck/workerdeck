import { errorMessage } from '@workerdeck/protocol'
import { randomUUID } from 'node:crypto'
import { historyUserText, itemCompleted, type ItemSink } from './items.ts'
import type { AppServerConnection, AppServerHistoryTurn } from './types.ts'

export type ResumedHistory = { turns: AppServerHistoryTurn[]; partial: boolean }

export type HistorySink = ItemSink & {
  closed(): boolean
  setReplaying(replaying: boolean): void
}

export type LoadedHistory = { turns: AppServerHistoryTurn[]; incomplete?: string }

// A resume answers with the newest page only; `thread/read` is the one call that returns the whole thread.
export async function loadHistory(
  connection: AppServerConnection,
  threadId: string | undefined,
  resumed: ResumedHistory | undefined,
): Promise<LoadedHistory> {
  const turns = resumed?.turns ?? []
  if (!resumed?.partial) {
    return { turns }
  }
  try {
    const read = (await connection.request('thread/read', { threadId, includeTurns: true })) as {
      thread?: { turns?: AppServerHistoryTurn[] }
    }
    const full = read?.thread?.turns
    if (Array.isArray(full) && full.length >= turns.length) {
      return { turns: full }
    }
    return { turns, incomplete: 'thread/read returned less history than the resume page' }
  } catch (error) {
    return { turns, incomplete: errorMessage(error) }
  }
}

export function incompleteHistoryNotice(reason: string): string {
  return `Resumed thread history is incomplete: older turns could not be loaded (${reason})`
}

export function replayTurns(sink: HistorySink, turns: readonly AppServerHistoryTurn[]): void {
  for (const turn of turns) {
    if (sink.closed()) {
      return
    }
    const scope = { nonce: randomUUID(), toolUseEmitted: new Set<string>(), sectionIndex: new Map<string, number>() }
    sink.setReplaying(true)
    try {
      for (const item of turn.items ?? []) {
        if (item.type !== 'userMessage') {
          itemCompleted(sink, item, scope)
          continue
        }
        const text = historyUserText(item)
        if (text) {
          sink.emit({
            type: 'user_message',
            message: { role: 'user', content: text },
            parentToolUseId: null,
            uuid: `${scope.nonce}:${item.id}`,
          })
        }
      }
    } finally {
      sink.setReplaying(false)
    }
  }
}
