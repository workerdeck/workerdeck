export const QUESTION_KINDS = ['decision', 'action', 'fyi'] as const
export type QuestionKind = (typeof QUESTION_KINDS)[number]

export const QUESTION_STATUSES = ['draft', 'open', 'answered', 'closed'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]

export const QUESTION_CLOSE_REASONS = ['resolved', 'superseded', 'withdrawn', 'rejected'] as const
export type QuestionCloseReason = (typeof QUESTION_CLOSE_REASONS)[number]

export const QUESTION_TITLE_MAX = 200
export const QUESTION_CONTEXT_MAX = 16_000
export const QUESTION_OPTIONS_MAX = 9
export const QUESTION_OPTION_LABEL_MAX = 200
export const QUESTION_OPTION_DETAIL_MAX = 2_000
export const QUESTION_ANSWER_MAX = 8_000
export const QUESTION_NOTE_MAX = 2_000
export const QUESTION_LINKS_MAX = 20
export const QUESTION_LINK_MAX = 1_000
export const QUESTION_WAITING_MAX = 20
export const QUESTION_ROUND_MAX = 80

export type QuestionOption = { key: string; label: string; detail?: string }

export type QuestionRecommendation = { choice?: string; why?: string }

// `by` is the human's owner name; `recordedBy` is the session that typed in an answer the human gave elsewhere.
export type QuestionAnswer = { choice?: string; text?: string; by: string; at: number; recordedBy?: string }

export type QuestionClosure = { reason: QuestionCloseReason; by: string; at: number; note?: string; supersededBy?: number }

export type QuestionItem = {
  board: string
  n: number
  kind: QuestionKind
  title: string
  context?: string
  options?: QuestionOption[]
  recommendation?: QuestionRecommendation
  blocking?: string
  waiting: string[]
  links?: string[]
  round?: string
  asker: string
  askerName?: string
  status: QuestionStatus
  answer?: QuestionAnswer
  closed?: QuestionClosure
  parent?: number
  // Sessions an answer or a rejection could not reach; they find it in `questions_list`.
  undelivered?: string[]
  createdAt: number
  updatedAt: number
}

export type QuestionBoardInfo = {
  id: string
  name?: string
  team: boolean
  drafts: number
  open: number
  blocking: number
  answered: number
  closed: number
  updatedAt: number
}

export type QuestionBoardsResponse = { boards: QuestionBoardInfo[] }

export type QuestionBoardResponse = { board: QuestionBoardInfo; items: QuestionItem[] }

export type AnswerQuestionRequest = { choice?: string; text?: string }

export type CloseQuestionRequest = { reason: QuestionCloseReason; note?: string; supersededBy?: number }

export type QuestionDelivery = { delivered: string[]; undelivered: string[] }

export type QuestionResponse = { item: QuestionItem; delivery?: QuestionDelivery }

export type QuestionsServerFrame =
  | { type: 'questions_attached'; protocolVersion: number; boards: QuestionBoardInfo[] }
  | { type: 'questions_changed'; board: QuestionBoardInfo }

export function isQuestionKind(value: unknown): value is QuestionKind {
  return typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value)
}

export function isQuestionStatus(value: unknown): value is QuestionStatus {
  return typeof value === 'string' && (QUESTION_STATUSES as readonly string[]).includes(value)
}

export function isQuestionCloseReason(value: unknown): value is QuestionCloseReason {
  return typeof value === 'string' && (QUESTION_CLOSE_REASONS as readonly string[]).includes(value)
}

export function questionAnswerLine(item: QuestionItem): string {
  const answer = item.answer
  if (!answer) {
    return ''
  }
  const option = answer.choice ? item.options?.find((candidate) => candidate.key === answer.choice) : undefined
  const choice = answer.choice ? (option ? `${answer.choice} (${option.label})` : answer.choice) : ''
  return [choice, answer.text].filter((part) => part && part.trim() !== '').join(': ')
}

export type QuestionRound = { round?: string; items: QuestionItem[] }

export type QuestionBoardView = {
  open: QuestionRound[]
  drafts: QuestionItem[]
  answered: QuestionItem[]
  closed: QuestionItem[]
}

export function questionBoardView(items: readonly QuestionItem[]): QuestionBoardView {
  const open = items.filter((item) => item.status === 'open').sort(byUrgency)
  const rounds = new Map<string | undefined, QuestionItem[]>()
  for (const item of open) {
    const round = rounds.get(item.round)
    if (round) {
      round.push(item)
    } else {
      rounds.set(item.round, [item])
    }
  }
  return {
    open: [...rounds].map(([round, members]) => (round === undefined ? { items: members } : { round, items: members })),
    drafts: items.filter((item) => item.status === 'draft').sort(byUrgency),
    answered: items.filter((item) => item.status === 'answered').sort((a, b) => (b.answer?.at ?? 0) - (a.answer?.at ?? 0)),
    closed: items.filter((item) => item.status === 'closed').sort((a, b) => (b.closed?.at ?? 0) - (a.closed?.at ?? 0)),
  }
}

export function sortQuestionBoards(boards: readonly QuestionBoardInfo[]): QuestionBoardInfo[] {
  return [...boards].sort((a, b) => b.blocking - a.blocking || b.open - a.open || b.updatedAt - a.updatedAt)
}

export function questionMatches(item: QuestionItem, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (needle === '') {
    return true
  }
  const hay = [`#${item.n}`, item.title, item.context, item.round, item.askerName, questionAnswerLine(item), item.closed?.note]
  return hay.some((part) => part?.toLowerCase().includes(needle))
}

function byUrgency(a: QuestionItem, b: QuestionItem): number {
  return Number(!!b.blocking) - Number(!!a.blocking) || a.createdAt - b.createdAt
}

// The offline copy of a board: generated on request, never kept in sync with anything.
export function questionBoardMarkdown(board: QuestionBoardInfo, items: readonly QuestionItem[]): string {
  const title = board.name ?? board.id
  const live = items.filter((item) => item.status === 'open' || item.status === 'draft')
  const answered = items.filter((item) => item.status === 'answered').sort((a, b) => (b.answer?.at ?? 0) - (a.answer?.at ?? 0))
  const closed = items.filter((item) => item.status === 'closed')
  const lines = [`# Questions: ${title}`, '']
  lines.push('## Open', '')
  if (live.length === 0) {
    lines.push('Nothing open.', '')
  }
  for (const item of live) {
    lines.push(...itemMarkdown(item))
  }
  lines.push('## Answered', '')
  for (const item of answered) {
    const at = item.answer ? isoDate(item.answer.at) : ''
    lines.push(`- **#${item.n}** ${item.title} (${at}, ${item.answer?.by ?? '?'}): ${questionAnswerLine(item)}`)
  }
  if (closed.length > 0) {
    lines.push('', '## Closed', '')
    for (const item of closed) {
      const closure = item.closed
      const why = closure
        ? `${closure.reason}${closure.supersededBy ? ` by #${closure.supersededBy}` : ''}${closure.note ? `: ${closure.note}` : ''}`
        : ''
      lines.push(`- **#${item.n}** ${item.title} (${why})`)
    }
  }
  return lines.join('\n') + '\n'
}

function itemMarkdown(item: QuestionItem): string[] {
  const tags = [
    item.kind,
    item.status === 'draft' ? 'draft' : undefined,
    item.round,
    item.parent ? `follow-up of #${item.parent}` : undefined,
  ]
  const lines = [
    `### #${item.n} ${item.title}`,
    '',
    `_${tags.filter(Boolean).join(', ')}; asked by ${item.askerName ?? item.asker}, updated ${isoDate(item.updatedAt)}_`,
    '',
  ]
  if (item.blocking) {
    lines.push(`**Blocking:** ${item.blocking}`, '')
  }
  if (item.context) {
    lines.push(item.context.trim(), '')
  }
  for (const option of item.options ?? []) {
    const recommended = item.recommendation?.choice === option.key ? ' **(recommended)**' : ''
    lines.push(`- **${option.key}**: ${option.label}${recommended}${option.detail ? ` - ${option.detail}` : ''}`)
  }
  if (item.options?.length) {
    lines.push('')
  }
  if (item.recommendation?.why) {
    lines.push(`Recommendation: ${item.recommendation.why}`, '')
  }
  for (const link of item.links ?? []) {
    lines.push(`- ${link}`)
  }
  if (item.links?.length) {
    lines.push('')
  }
  return lines
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
