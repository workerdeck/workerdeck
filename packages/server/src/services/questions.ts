import type {
  QuestionAskInput,
  QuestionCloseInput,
  QuestionDirectory,
  QuestionListInput,
  QuestionRecordInput,
  QuestionUpdateInput,
} from '@workerdeck/core'
import {
  QUESTION_ANSWER_MAX,
  QUESTION_NOTE_MAX,
  isQuestionCloseReason,
  questionAnswerLine,
  type AnswerQuestionRequest,
  type CloseQuestionRequest,
  type MessageOrigin,
  type QuestionAnswer,
  type QuestionBoardInfo,
  type QuestionBoardResponse,
  type QuestionCloseReason,
  type QuestionDelivery,
  type QuestionItem,
  type QuestionOption,
  type QuestionResponse,
} from '@workerdeck/protocol'
import type { QuestionStore, StoredQuestionBoard } from './question-store.ts'

export type QuestionAgent = { id: string; name: string; lead?: string }

export type QuestionServiceDeps = {
  store: QuestionStore
  agent: (sessionId: string) => QuestionAgent | undefined
  leads: (sessionId: string) => boolean
  name: (sessionId: string) => string | undefined
  // Who a recorded answer is attributed to: the gateway's owner.
  human: () => string
  // Answers a refusal reason, or undefined once the text is in the session's input.
  deliver: (sessionId: string, text: string, origin?: MessageOrigin) => Promise<string | undefined>
  onChange?: (board: string) => void
  onError?: (error: unknown) => void
  now?: () => number
}

export class QuestionRefusal extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

type BoardRef = { id: string; team: boolean }

type EditFields = Omit<QuestionUpdateInput, 'n' | 'publish'>

export class QuestionService implements QuestionDirectory {
  readonly #deps: QuestionServiceDeps
  readonly #boards = new Map<string, StoredQuestionBoard>()
  #closed = false

  constructor(deps: QuestionServiceDeps) {
    this.#deps = deps
    for (const board of deps.store.list()) {
      this.#boards.set(board.id, board)
    }
  }

  stop(): void {
    this.#closed = true
  }

  boardOf(sessionId: string): BoardRef {
    const agent = this.#deps.agent(sessionId)
    if (agent?.lead && !agent.lead.includes(':')) {
      return { id: agent.lead, team: true }
    }
    return { id: sessionId, team: agent !== undefined && this.#deps.leads(sessionId) }
  }

  boards(): QuestionBoardInfo[] {
    return [...this.#boards.values()]
      .filter((board) => board.items.length > 0)
      .map((board) => this.#info(board))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  boardInfo(id: string): QuestionBoardInfo | undefined {
    const board = this.#boards.get(id)
    return board ? this.#info(board) : undefined
  }

  board(id: string, options: { drafts?: boolean } = {}): QuestionBoardResponse | undefined {
    const board = this.#boards.get(id)
    if (!board) {
      return undefined
    }
    const items = options.drafts ? board.items : board.items.filter((item) => item.status !== 'draft')
    return { board: this.#info(board), items: items.map((item) => structuredClone(item)) }
  }

  async ask(from: string, input: QuestionAskInput): Promise<string> {
    const ref = this.boardOf(from)
    const board = this.#boardFor(ref.id)
    if (input.parent !== undefined) {
      this.#item(board, input.parent)
    }
    const draft = ref.team && from !== ref.id
    const now = this.#now()
    const item: QuestionItem = {
      board: ref.id,
      n: board.next,
      kind: input.kind ?? 'decision',
      title: input.title,
      waiting: [],
      asker: from,
      status: draft ? 'draft' : 'open',
      createdAt: now,
      updatedAt: now,
    }
    applyFields(item, input, from)
    if (input.parent !== undefined) {
      item.parent = input.parent
    }
    const askerName = this.#deps.name(from)
    if (askerName) {
      item.askerName = askerName
    }
    this.#write(board, () => {
      board.next += 1
      board.items.push(item)
    })
    if (!draft) {
      return `Posted #${item.n} to the question board. The human sees it now; you get a message when it is answered.`
    }
    const reason = await this.#deps.deliver(
      ref.id,
      `Draft #${item.n} on your team's question board from ${askerName ?? from}: ${item.title}\n` +
        'Publish it to the human with questions_update (publish: true), edit or merge it first, or reject it with ' +
        'questions_close (reason: rejected, note: why).',
      this.#origin(from),
    )
    const lead = this.#deps.name(ref.id) ?? ref.id
    return reason
      ? `Posted #${item.n} as a draft for your lead ${lead}, who could not be told (${reason}); it waits on the board.`
      : `Posted #${item.n} as a draft for your lead ${lead}, who decides whether it goes to the human.`
  }

  async list(from: string, input: QuestionListInput): Promise<string> {
    const ref = this.boardOf(from)
    const board = this.#boards.get(ref.id)
    if (input.n !== undefined) {
      return JSON.stringify(this.#item(board, input.n), null, 2)
    }
    const items = (board?.items ?? []).filter((item) => {
      if (input.status && item.status !== input.status) {
        return false
      }
      if (input.filter === 'mine') {
        return item.asker === from
      }
      if (input.filter === 'waiting') {
        return item.asker === from || item.waiting.includes(from)
      }
      return true
    })
    if (items.length === 0) {
      return 'Nothing on the question board matches.'
    }
    return [board ? headline(this.#info(board)) : '', ...items.map(itemLine)].join('\n')
  }

  async update(from: string, input: QuestionUpdateInput): Promise<string> {
    const ref = this.boardOf(from)
    const board = this.#boards.get(ref.id)
    const item = this.#item(board, input.n)
    const lead = from === ref.id
    if (item.asker !== from && !lead) {
      throw new QuestionRefusal(403, `#${item.n} is not yours to edit; ask its asker or your lead`)
    }
    if (item.status !== 'draft' && item.status !== 'open') {
      throw new QuestionRefusal(409, `#${item.n} is ${item.status}; post a follow-up with questions_ask (parent: ${item.n}) instead`)
    }
    if (input.publish && !lead) {
      throw new QuestionRefusal(403, 'only the lead publishes a draft')
    }
    const { n: _n, publish, ...fields } = input
    this.#write(board!, () => {
      applyFields(item, fields, from)
      if (publish && item.status === 'draft') {
        item.status = 'open'
      }
      item.updatedAt = this.#now()
    })
    return publish ? `Published #${item.n}; the human sees it now.` : `Updated #${item.n}.`
  }

  async recordAnswer(from: string, input: QuestionRecordInput): Promise<string> {
    const ref = this.boardOf(from)
    if (from !== ref.id) {
      throw new QuestionRefusal(403, 'only the lead records an answer the human gave elsewhere')
    }
    const item = this.#item(this.#boards.get(ref.id), input.n)
    const delivery = await this.#answer(ref.id, item, { choice: input.choice, text: input.text }, this.#deps.human(), from)
    return `Recorded the answer on #${item.n}.${deliveryLine(delivery, (id) => this.#deps.name(id) ?? id)}`
  }

  async answer(boardId: string, n: number, request: AnswerQuestionRequest, by: string): Promise<QuestionResponse> {
    const item = this.#item(this.#boards.get(boardId), n)
    const delivery = await this.#answer(boardId, item, request, by)
    return { item: structuredClone(item), delivery }
  }

  async closeByHuman(boardId: string, n: number, request: CloseQuestionRequest, by: string): Promise<QuestionResponse> {
    const board = this.#boards.get(boardId)
    const item = this.#item(board, n)
    this.#shut(board!, item, request, by)
    return { item: structuredClone(item) }
  }

  async closeItem(from: string, input: QuestionCloseInput): Promise<string> {
    const ref = this.boardOf(from)
    const board = this.#boards.get(ref.id)
    const item = this.#item(board, input.n)
    const lead = from === ref.id
    if (item.asker !== from && !lead) {
      throw new QuestionRefusal(403, `#${item.n} is not yours to close`)
    }
    if (input.reason === 'rejected' && (!lead || item.status !== 'draft')) {
      throw new QuestionRefusal(409, 'only the lead rejects, and only a draft')
    }
    this.#shut(board!, item, input, from)
    if (input.reason !== 'rejected' || item.asker === from) {
      return `Closed #${item.n} (${input.reason}).`
    }
    const reason = await this.#deps.deliver(
      item.asker,
      `Your draft #${item.n} on the question board was rejected by your lead${input.note ? `: ${input.note}` : '.'}`,
      this.#origin(from),
    )
    if (reason) {
      this.#write(board!, () => {
        item.undelivered = [item.asker]
      })
    }
    return `Rejected #${item.n}.${reason ? ` The asker could not be told (${reason}); it sees it in questions_list.` : ''}`
  }

  #shut(board: StoredQuestionBoard, item: QuestionItem, request: CloseQuestionRequest, by: string): void {
    if (!isQuestionCloseReason(request.reason)) {
      throw new QuestionRefusal(400, 'reason must be resolved, superseded, withdrawn or rejected')
    }
    if (item.status === 'closed') {
      throw new QuestionRefusal(409, `#${item.n} is already closed`)
    }
    if (request.supersededBy !== undefined) {
      this.#item(board, request.supersededBy)
    }
    const note = typeof request.note === 'string' ? request.note.trim().slice(0, QUESTION_NOTE_MAX) : ''
    this.#write(board, () => {
      item.status = 'closed'
      item.closed = {
        reason: request.reason as QuestionCloseReason,
        by,
        at: this.#now(),
        ...(note ? { note } : {}),
        ...(request.supersededBy !== undefined ? { supersededBy: request.supersededBy } : {}),
      }
      item.updatedAt = this.#now()
    })
  }

  async #answer(
    boardId: string,
    item: QuestionItem,
    request: AnswerQuestionRequest,
    by: string,
    recordedBy?: string,
  ): Promise<QuestionDelivery> {
    const board = this.#boards.get(boardId)!
    if (item.status === 'answered' || item.status === 'closed') {
      throw new QuestionRefusal(409, `#${item.n} is already ${item.status}`)
    }
    if (item.status === 'draft' && recordedBy === undefined) {
      throw new QuestionRefusal(409, `#${item.n} is a draft its lead has not published`)
    }
    const choice = typeof request.choice === 'string' ? request.choice.trim() : ''
    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (!choice && !text) {
      throw new QuestionRefusal(400, 'an answer needs a choice or text')
    }
    if (choice && !item.options?.some((option) => option.key === choice)) {
      throw new QuestionRefusal(400, `#${item.n} has no option ${choice}`)
    }
    if (text.length > QUESTION_ANSWER_MAX) {
      throw new QuestionRefusal(400, `an answer is at most ${QUESTION_ANSWER_MAX} characters`)
    }
    const answer: QuestionAnswer = {
      ...(choice ? { choice } : {}),
      ...(text ? { text } : {}),
      by,
      at: this.#now(),
      ...(recordedBy ? { recordedBy } : {}),
    }
    this.#write(board, () => {
      item.status = 'answered'
      item.answer = answer
      item.updatedAt = answer.at
      delete item.undelivered
    })
    const recipients = [...new Set([item.asker, boardId, ...item.waiting])].filter((id) => id !== recordedBy)
    const recorder = recordedBy ? ` (recorded by ${this.#deps.name(recordedBy) ?? recordedBy})` : ''
    const message =
      `Question #${item.n} on the question board was answered by ${by}${recorder}: ${questionAnswerLine(item)}\n` +
      `It asked: ${item.title}\nquestions_list (n: ${item.n}) has the full item.`
    const origin = recordedBy ? this.#origin(recordedBy) : undefined
    const delivery: QuestionDelivery = { delivered: [], undelivered: [] }
    for (const sessionId of recipients) {
      const reason = await this.#deps.deliver(sessionId, message, origin).catch((error: unknown) => String(error))
      ;(reason ? delivery.undelivered : delivery.delivered).push(sessionId)
    }
    if (delivery.undelivered.length > 0) {
      this.#write(board, () => {
        item.undelivered = delivery.undelivered
      })
    }
    return delivery
  }

  #origin(sessionId: string): MessageOrigin {
    const name = this.#deps.name(sessionId)
    return { kind: 'peer', sessionId, ...(name ? { name } : {}) }
  }

  #boardFor(id: string): StoredQuestionBoard {
    const existing = this.#boards.get(id)
    if (existing) {
      return existing
    }
    const board: StoredQuestionBoard = { id, next: 1, items: [] }
    this.#boards.set(id, board)
    return board
  }

  #item(board: StoredQuestionBoard | undefined, n: number): QuestionItem {
    const item = board?.items.find((candidate) => candidate.n === n)
    if (!item) {
      throw new QuestionRefusal(404, `no item #${n} on this question board`)
    }
    return item
  }

  #info(board: StoredQuestionBoard): QuestionBoardInfo {
    const count = (status: QuestionItem['status']) => board.items.filter((item) => item.status === status).length
    const name = this.#deps.name(board.id)
    return {
      id: board.id,
      ...(name ? { name } : {}),
      team: this.boardOf(board.id).team,
      drafts: count('draft'),
      open: count('open'),
      blocking: board.items.filter((item) => item.status === 'open' && item.blocking).length,
      answered: count('answered'),
      closed: count('closed'),
      updatedAt: Math.max(0, ...board.items.map((item) => item.updatedAt)),
    }
  }

  #write(board: StoredQuestionBoard, mutate: () => void): void {
    if (this.#closed) {
      throw new QuestionRefusal(503, 'the question board is closing')
    }
    mutate()
    try {
      this.#deps.store.save(board)
    } catch (error) {
      this.#deps.onError?.(error)
    }
    this.#deps.onChange?.(board.id)
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }
}

function applyFields(item: QuestionItem, fields: EditFields, from: string): void {
  if (fields.kind !== undefined) {
    item.kind = fields.kind
  }
  if (fields.title !== undefined) {
    item.title = fields.title
  }
  if (fields.context !== undefined) {
    setOrDrop(item, 'context', fields.context.trim())
  }
  if (fields.options !== undefined) {
    const options: QuestionOption[] = fields.options.map((option) => ({
      key: option.key,
      label: option.label,
      ...(option.detail?.trim() ? { detail: option.detail.trim() } : {}),
    }))
    const keys = new Set(options.map((option) => option.key))
    if (keys.size !== options.length) {
      throw new QuestionRefusal(400, 'option keys must be unique')
    }
    setOrDrop(item, 'options', options.length ? options : undefined)
  }
  if (fields.recommend !== undefined || fields.why !== undefined) {
    const choice = fields.recommend ?? item.recommendation?.choice
    const why = fields.why?.trim() ?? item.recommendation?.why
    setOrDrop(item, 'recommendation', choice || why ? { ...(choice ? { choice } : {}), ...(why ? { why } : {}) } : undefined)
  }
  if (item.recommendation?.choice && !item.options?.some((option) => option.key === item.recommendation?.choice)) {
    throw new QuestionRefusal(400, `the recommendation ${item.recommendation.choice} is not one of the options`)
  }
  if (fields.blocking !== undefined) {
    setOrDrop(item, 'blocking', fields.blocking.trim())
  }
  if (fields.waiting !== undefined) {
    item.waiting = [...new Set(fields.waiting)].filter((id) => id !== from)
  }
  if (fields.links !== undefined) {
    setOrDrop(item, 'links', fields.links.length ? fields.links : undefined)
  }
  if (fields.round !== undefined) {
    setOrDrop(item, 'round', fields.round.trim())
  }
}

function setOrDrop<K extends keyof QuestionItem>(item: QuestionItem, key: K, value: QuestionItem[K] | '' | undefined): void {
  if (value === undefined || value === '') {
    delete item[key]
    return
  }
  item[key] = value as QuestionItem[K]
}

function headline(info: QuestionBoardInfo): string {
  const drafts = info.drafts ? `, ${info.drafts} draft${info.drafts === 1 ? '' : 's'}` : ''
  return `Question board ${info.name ?? info.id}: ${info.open} open${drafts}, ${info.answered} answered.`
}

function itemLine(item: QuestionItem): string {
  const head = `#${item.n} [${item.status}, ${item.kind}] ${item.title} (asked by ${item.askerName ?? item.asker}, updated ${day(item.updatedAt)})`
  if (item.status === 'answered' && item.answer) {
    return `${head}\n    answered ${day(item.answer.at)} by ${item.answer.by}: ${questionAnswerLine(item)}`
  }
  if (item.status === 'closed' && item.closed) {
    return `${head}\n    closed: ${item.closed.reason}${item.closed.supersededBy ? ` by #${item.closed.supersededBy}` : ''}${item.closed.note ? `: ${item.closed.note}` : ''}`
  }
  const extra = [
    item.blocking ? `blocking: ${item.blocking}` : '',
    item.options?.length
      ? `options: ${item.options.map((option) => `${option.key}) ${option.label}${item.recommendation?.choice === option.key ? ' (recommended)' : ''}`).join('; ')}`
      : '',
  ].filter(Boolean)
  return [head, ...extra.map((line) => `    ${line}`)].join('\n')
}

function deliveryLine(delivery: QuestionDelivery, name: (id: string) => string): string {
  const told = delivery.delivered.length ? ` Told ${delivery.delivered.map(name).join(', ')}.` : ''
  const missed = delivery.undelivered.length
    ? ` Could not reach ${delivery.undelivered.map(name).join(', ')}; it waits in their questions_list.`
    : ''
  return told + missed
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
