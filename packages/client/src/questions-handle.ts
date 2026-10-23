import type { QuestionBoardInfo, QuestionsServerFrame } from '@workerdeck/protocol'
import { Emitter, reconnectDelay, type Listener } from './lib/emitter.ts'
import type { WorkerDeckClient } from './index.ts'

export type QuestionsHandleEvents = {
  attached: QuestionBoardInfo[]
  changed: QuestionBoardInfo
  connectionChange: boolean
}

export class QuestionsHandle {
  #client: WorkerDeckClient
  #reconnect: boolean
  #ws: WebSocket | undefined
  #events = new Emitter<QuestionsHandleEvents>()
  #closed = false
  #retries = 0
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, options: { reconnect?: boolean } = {}) {
    this.#client = client
    this.#reconnect = options.reconnect ?? true
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  on<K extends keyof QuestionsHandleEvents>(kind: K, listener: Listener<QuestionsHandleEvents[K]>): () => void {
    return this.#events.on(kind, listener)
  }

  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  #connect(): void {
    if (this.#closed) {
      return
    }
    const ws = this.#client.openQuestionsSocket()
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#events.emit('connectionChange', true)
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as QuestionsServerFrame
      if (frame.type === 'questions_attached') {
        this.#events.emit('attached', frame.boards)
      } else if (frame.type === 'questions_changed') {
        this.#events.emit('changed', frame.board)
      }
    }
    ws.onclose = () => {
      this.#events.emit('connectionChange', false)
      if (this.#closed || !this.#reconnect) {
        return
      }
      const delay = reconnectDelay(this.#retries++)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {}
  }
}
