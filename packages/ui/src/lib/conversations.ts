import { unconfirmedInputOf, WorkerDeckError, type WorkerDeckClient } from '@workerdeck/client'
import type {
  ArchivedView,
  ConversationRow,
  ConversationsResponse,
  NewConversationRequest,
  NewConversationResponse,
  UnconfirmedInputRefusal,
} from '@workerdeck/protocol'
import { INPUT_CHANGED_CODE, UNCERTAIN_PROMPT_CODE } from '@workerdeck/protocol'

export type ConversationRowText = {
  date: string
  title: string
  duration?: string
  current: boolean
}

export type ArchivedBannerText = {
  headline: string
  note?: string
}

export type DiscardConfirmText = {
  title: string
  detail: string
  confirm: string
}

export type CutClient = Pick<WorkerDeckClient, 'newConversation' | 'discardAndCut'>

// No `target`: a discard binds the refused set and cannot carry one, so a confirmed cut would silently lose it.
export type CutRequest = Omit<NewConversationRequest, 'target'>

export type ConversationRecovery = {
  startFailed?: { n: number; error: string }
  uncertainPrompt?: { n: number; text: string }
}

export type ConfirmDiscard = (text: DiscardConfirmText, refusal: UnconfirmedInputRefusal) => Promise<boolean>

export function conversationDate(at: number | undefined, locale?: string): string {
  if (at === undefined) {
    return 'Date unknown'
  }
  return new Date(at).toLocaleString(locale, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function conversationSpan(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) {
    return 'under a minute'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  }
  return `${Math.round(hours / 24)}d`
}

// The current conversation has no end yet, so its duration runs to `now`.
export function conversationRowText(row: ConversationRow, now = Date.now(), locale?: string): ConversationRowText {
  const end = row.endedAt ?? (row.current ? now : undefined)
  const duration =
    row.startedAt !== undefined && end !== undefined && end >= row.startedAt ? conversationSpan(end - row.startedAt) : undefined
  return {
    date: conversationDate(row.startedAt ?? row.endedAt, locale),
    title: row.title?.trim() || (row.transcript === 'unavailable' ? 'Transcript unavailable' : 'Untitled conversation'),
    ...(duration === undefined ? {} : { duration }),
    current: row.current,
  }
}

export function archivedBannerText(view: ArchivedView, locale?: string): ArchivedBannerText {
  const headline = `Past conversation · ${conversationDate(view.at, locale)}`
  const notes = [view.kind === 'deleted' ? 'Closed' : undefined, view.unavailable ? 'Transcript unavailable' : undefined].filter(
    (note): note is string => note !== undefined,
  )
  return notes.length === 0 ? { headline } : { headline, note: notes.join(' · ') }
}

export function discardConfirmText(refusal: UnconfirmedInputRefusal): DiscardConfirmText {
  const count = refusal.pendingInput
  const what = count > 0 ? `${count} message${count === 1 ? '' : 's'}` : 'queued input'
  const unanswered = `${count === 1 || count <= 0 ? 'has' : 'have'} no answer yet`
  const lead =
    refusal.code === INPUT_CHANGED_CODE
      ? `More input arrived: ${what} ${unanswered}.`
      : `${capital(what)} sent to this session ${unanswered}.`
  const peer = refusal.mayIncludePeer ? ' Some of it may come from peer agents, who will not get a reply.' : ''
  return {
    title: `Discard ${what} and start a new conversation?`,
    detail: `${lead} A new conversation drops it for good; none of it is carried over.${peer}`,
    confirm: 'Discard and start',
  }
}

// The cut as a person asks for it: a refusal over unread input asks `confirm`, and input that arrives meanwhile asks again.
export async function startNewConversation(
  client: CutClient,
  id: string,
  request: CutRequest,
  confirm: ConfirmDiscard,
): Promise<NewConversationResponse | undefined> {
  let refusal: UnconfirmedInputRefusal
  try {
    return await client.newConversation(id, {
      expectedGeneration: request.expectedGeneration,
      ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
    })
  } catch (err) {
    const first = unconfirmedInputOf(err)
    if (!first) {
      throw err
    }
    refusal = first
  }
  for (;;) {
    if (!(await confirm(discardConfirmText(refusal), refusal))) {
      return undefined
    }
    try {
      return await client.discardAndCut(id, {
        expectedGeneration: refusal.conversation,
        inputRevision: refusal.inputRevision,
        ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
      })
    } catch (err) {
      const next = unconfirmedInputOf(err)
      if (!next) {
        throw err
      }
      refusal = next
    }
  }
}

// A cut refused until a person decides on a prompt that may not have reached the engine: Send again or Dismiss, both bound to `promptConversation`.
export function uncertainPromptOf(error: unknown): { promptConversation: number } | undefined {
  if (!(error instanceof WorkerDeckError) || error.status !== 409 || error.code !== UNCERTAIN_PROMPT_CODE) {
    return undefined
  }
  const n = error.body?.promptConversation
  return typeof n === 'number' ? { promptConversation: n } : undefined
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

// Newest first, the current conversation on top (its start is the previous one's end).
export function conversationList(response: ConversationsResponse, currentTitle?: string): ConversationRow[] {
  const history = [...response.history].sort((a, b) => b.n - a.n)
  const rows: ConversationRow[] = []
  if (response.conversation !== undefined && !response.closed) {
    const startedAt = history[0]?.endedAt
    rows.push({
      n: response.conversation,
      current: true,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(currentTitle ? { title: currentTitle } : {}),
    })
  }
  for (const entry of history) {
    rows.push({
      n: entry.n,
      current: false,
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
      endedAt: entry.endedAt,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.transcript ? { transcript: entry.transcript } : {}),
    })
  }
  return rows
}

export function conversationRecovery(response: ConversationsResponse): ConversationRecovery {
  const prompt = response.pendingPrompt
  return {
    ...(response.startFailed ? { startFailed: { n: response.startFailed.n, error: response.startFailed.error } } : {}),
    ...(prompt?.state === 'uncertain' ? { uncertainPrompt: { n: response.conversation ?? prompt.n, text: prompt.text } } : {}),
  }
}
