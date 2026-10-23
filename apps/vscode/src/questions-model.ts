import * as vscode from 'vscode'
import { WorkerDeckError, type QuestionsHandle, type WorkerDeckClient } from '@workerdeck/client'
import { sortQuestionBoards, type QuestionBoardInfo, type QuestionItem } from '@workerdeck/protocol'
import { clientFor } from './gateway.ts'
import type { GatewayHost, HostStore } from './hosts.ts'

const RETRY_MS = 30_000

export type QuestionBoardRow = QuestionBoardInfo & { hostId: string; hostName: string }

export type OpenedQuestion = { hostId: string; board: QuestionBoardInfo; item: QuestionItem }

type HostLink = {
  host: GatewayHost
  client: WorkerDeckClient
  boards: QuestionBoardInfo[]
  // Open item numbers per board, last seen. A board missing here has never been read.
  known: Map<string, Set<number>>
  queue: Map<string, Promise<void>>
  seeded: boolean
  handle?: QuestionsHandle
  retry?: ReturnType<typeof setTimeout>
  closed: boolean
}

export class QuestionsModel implements vscode.Disposable {
  readonly #store: HostStore
  readonly #links = new Map<string, HostLink>()
  readonly #onDidChange = new vscode.EventEmitter<void>()
  readonly #onDidOpen = new vscode.EventEmitter<OpenedQuestion>()
  readonly #subscription: vscode.Disposable
  readonly onDidChange = this.#onDidChange.event
  readonly onDidOpen = this.#onDidOpen.event

  constructor(store: HostStore) {
    this.#store = store
    this.#subscription = store.onDidChange(() => void this.reconnect())
  }

  rows(): QuestionBoardRow[] {
    const rows = [...this.#links.values()].flatMap((link) =>
      link.boards.map((board) => ({ ...board, hostId: link.host.id, hostName: link.host.name })),
    )
    return sortQuestionBoards(rows)
  }

  async reconnect(): Promise<void> {
    for (const link of this.#links.values()) {
      close(link)
    }
    this.#links.clear()
    await Promise.all(this.#store.all().map((host) => this.#connect(host)))
    this.#onDidChange.fire()
  }

  async #connect(host: GatewayHost): Promise<void> {
    const client = await clientFor(this.#store, host)
    if (!client) {
      return
    }
    const link: HostLink = { host, client, boards: [], known: new Map(), queue: new Map(), seeded: false, closed: false }
    this.#links.set(host.id, link)
    void this.#start(link)
  }

  // REST first: a gateway with the board off refuses the socket upgrade, and the handle would reconnect forever.
  async #start(link: HostLink): Promise<void> {
    try {
      link.boards = await link.client.questionBoards()
    } catch (error) {
      if (!link.closed && !(error instanceof WorkerDeckError && error.status === 404)) {
        link.retry = setTimeout(() => void this.#start(link), RETRY_MS)
      }
      return
    }
    if (link.closed) {
      return
    }
    this.#onDidChange.fire()
    const handle = link.client.attachQuestions()
    link.handle = handle
    handle.on('attached', (boards) => {
      link.boards = boards
      this.#onDidChange.fire()
      for (const board of boards) {
        this.#track(link, board, link.seeded)
      }
      link.seeded = true
    })
    handle.on('changed', (board) => {
      link.boards = [board, ...link.boards.filter((other) => other.id !== board.id)]
      this.#onDidChange.fire()
      this.#track(link, board, true)
    })
  }

  #track(link: HostLink, board: QuestionBoardInfo, announce: boolean): void {
    const previous = link.queue.get(board.id) ?? Promise.resolve()
    const next = previous.then(() => this.#diff(link, board, announce)).catch(() => {})
    link.queue.set(board.id, next)
  }

  // `announce` is false only for the first look at a gateway: what was open before this window connected is not news.
  async #diff(link: HostLink, board: QuestionBoardInfo, announce: boolean): Promise<void> {
    const before = link.known.get(board.id) ?? (announce ? new Set<number>() : undefined)
    if (board.open === 0) {
      link.known.set(board.id, new Set())
      return
    }
    const { items } = await link.client.questionBoard(board.id)
    if (link.closed) {
      return
    }
    const open = items.filter((item) => item.status === 'open')
    link.known.set(board.id, new Set(open.map((item) => item.n)))
    for (const item of open) {
      if (before && !before.has(item.n)) {
        this.#onDidOpen.fire({ hostId: link.host.id, board, item })
      }
    }
  }

  dispose(): void {
    this.#subscription.dispose()
    for (const link of this.#links.values()) {
      close(link)
    }
    this.#links.clear()
    this.#onDidChange.dispose()
    this.#onDidOpen.dispose()
  }
}

function close(link: HostLink): void {
  link.closed = true
  clearTimeout(link.retry)
  link.handle?.detach()
}
