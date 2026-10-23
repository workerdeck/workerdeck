import * as vscode from 'vscode'
import { questionBoardMarkdown } from '@workerdeck/protocol'
import type { HostToQuestions, QuestionsToHost } from './bridge-protocol.ts'
import { clientFor } from './gateway.ts'
import { apiUrl, type HostStore } from './hosts.ts'
import type { QuestionBoardRow, QuestionsModel } from './questions-model.ts'
import { WebviewTransportHost } from './webview-transports.ts'
import { WebviewViewHost } from './webview-host.ts'

const SELECTION_KEY = 'workerdeck.questions.board'

type BoardRef = { hostId: string; boardId: string }

export type QuestionsFeed = {
  openLink: (hostId: string, asker: string, link: string) => Promise<void>
}

export class QuestionsViewProvider extends WebviewViewHost<QuestionsToHost, HostToQuestions> implements vscode.Disposable {
  static readonly viewId = 'workerdeck.questions'

  readonly #store: HostStore
  readonly #model: QuestionsModel
  readonly #state: vscode.Memento
  readonly #feed: QuestionsFeed
  #transports: WebviewTransportHost | undefined

  protected readonly bundle = 'questions.js'

  constructor(extensionUri: vscode.Uri, store: HostStore, model: QuestionsModel, state: vscode.Memento, feed: QuestionsFeed) {
    super(extensionUri)
    this.#store = store
    this.#model = model
    this.#state = state
    this.#feed = feed
  }

  current(): QuestionBoardRow | undefined {
    const rows = this.#model.rows()
    const picked = this.#state.get<BoardRef>(SELECTION_KEY)
    return rows.find((row) => row.hostId === picked?.hostId && row.id === picked?.boardId) ?? rows[0]
  }

  async select(hostId: string, boardId: string): Promise<void> {
    await this.#state.update(SELECTION_KEY, { hostId, boardId })
    this.push()
  }

  async show(hostId: string, boardId: string): Promise<void> {
    await this.select(hostId, boardId)
    await vscode.commands.executeCommand(`${QuestionsViewProvider.viewId}.focus`)
  }

  async pickBoard(): Promise<void> {
    const rows = this.#model.rows()
    if (rows.length === 0) {
      void vscode.window.showInformationMessage('WorkerDeck: no question boards yet. Agents create one with questions_ask.')
      return
    }
    const gateways = new Set(rows.map((row) => row.hostId)).size
    const current = this.current()
    const picked = await vscode.window.showQuickPick(
      rows.map((row) => ({
        label: row.name ?? row.id,
        description: [row.team ? 'team' : 'session', gateways > 1 ? row.hostName : undefined].filter(Boolean).join(' · '),
        detail: boardCounts(row),
        picked: row === current,
        row,
      })),
      { title: 'Question board', placeHolder: 'Pick a board to show' },
    )
    if (picked) {
      await this.select(picked.row.hostId, picked.row.id)
    }
  }

  async exportBoard(): Promise<void> {
    const row = this.current()
    const host = row && this.#store.get(row.hostId)
    const client = host && (await clientFor(this.#store, host))
    if (!row || !client) {
      return
    }
    const { board, items } = await client.questionBoard(row.id)
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: questionBoardMarkdown(board, items) })
    await vscode.window.showTextDocument(doc, { preview: false })
  }

  protected override wire(_view: vscode.WebviewView): void {
    this.resetForReload()
  }

  protected override resetForReload(): void {
    this.#transports?.dispose()
    this.#transports = new WebviewTransportHost(this.#store, (msg) => this.post(msg))
  }

  protected override afterResolve(): void {
    this.push()
  }

  protected override intercept(msg: QuestionsToHost): Promise<boolean> | boolean {
    return this.#transports?.handle(msg) ?? false
  }

  protected override onReady(): void {
    this.push()
  }

  protected override async onMessage(msg: QuestionsToHost): Promise<void> {
    if (msg.kind === 'wd-question-link') {
      const row = this.current()
      if (row) {
        await this.#feed.openLink(row.hostId, msg.asker, msg.link)
      }
    }
  }

  protected override onViewDisposed(): void {
    this.#transports?.dispose()
  }

  push(): void {
    const view = this.view
    if (!view) {
      return
    }
    const rows = this.#model.rows()
    const row = this.current()
    const open = rows.reduce((sum, board) => sum + board.open, 0)
    const blocking = rows.reduce((sum, board) => sum + board.blocking, 0)
    view.badge = open > 0 ? { value: open, tooltip: `${open} open question${open === 1 ? '' : 's'}${blocking ? `, ${blocking} blocking` : ''}` } : undefined
    view.description = row ? (row.name ?? row.id) : undefined
    if (!this.ready) {
      return
    }
    const host = row && this.#store.get(row.hostId)
    const baseUrl = host && apiUrl(host)
    this.post({
      kind: 'wd-questions',
      target: row && baseUrl ? { hostId: row.hostId, baseUrl, boardId: row.id, version: row.updatedAt } : undefined,
      empty: this.#store.all().length === 0 ? 'Add a gateway to see its question boards.' : 'No questions yet. Agents post here with questions_ask.',
    })
  }

  dispose(): void {
    this.#transports?.dispose()
  }
}

function boardCounts(row: QuestionBoardRow): string {
  const parts = [`${row.open} open`, row.blocking ? `${row.blocking} blocking` : undefined, `${row.answered} answered`]
  return parts.filter(Boolean).join(' · ')
}
