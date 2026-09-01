import type { JobEvent, QueueServerFrame, QueueStats } from '@workerdeck/protocol'
import { Emitter, reconnectDelay, type Listener } from './lib/emitter.ts'
import type { WorkerDeckClient } from './index.ts'

export type QueueHandleEvents = {
  attached: QueueStats
  event: JobEvent
  stats: QueueStats
  connectionChange: boolean
}

export class QueueHandle {
  #client: WorkerDeckClient
  #reconnect: boolean
  #ws: WebSocket | undefined
  #events = new Emitter<QueueHandleEvents>()
  #closed = false
  #retries = 0
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, options: { reconnect?: boolean } = {}) {
    this.#client = client
    this.#reconnect = options.reconnect ?? true
    // Deferred a tick for the same StrictMode reason as SessionHandle.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  on<K extends keyof QueueHandleEvents>(kind: K, listener: Listener<QueueHandleEvents[K]>): () => void {
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
    const ws = this.#client.openQueueSocket()
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#events.emit('connectionChange', true)
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as QueueServerFrame
      if (frame.type === 'queue_attached') {
        this.#events.emit('attached', frame.stats)
        this.#events.emit('stats', frame.stats)
      } else if (frame.type === 'job_event') {
        this.#events.emit('event', frame.event)
      } else if (frame.type === 'queue_stats') {
        this.#events.emit('stats', frame.stats)
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
