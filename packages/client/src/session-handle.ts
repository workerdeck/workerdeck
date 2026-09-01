import type {
  AttachedFrame,
  ClientFrame,
  PermissionMode,
  ServerFrame,
  SessionEvent,
  ToolCallRequestFrame,
  ToolExecutionOutput,
} from '@workerdeck/protocol'
import { Emitter, reconnectDelay, type Listener } from './lib/emitter.ts'
import type { WorkerDeckClient } from './index.ts'

export type AttachOptions = {
  afterSeq?: number
  reconnect?: boolean
  truncateResults?: boolean
  imageRefs?: boolean
}

export type SessionHandleEvents = {
  attached: AttachedFrame
  event: SessionEvent
  protocolError: string
  connectionChange: boolean
  reconnectAttempt: number
  toolCallRequest: ToolCallRequestFrame
  toolCallCanceled: { executionId: string; reason: string }
}

export class SessionHandle {
  readonly sessionId: string
  #client: WorkerDeckClient
  #options: Required<Pick<AttachOptions, 'reconnect'>> & AttachOptions
  #ws: WebSocket | undefined
  #events = new Emitter<SessionHandleEvents>()
  #lastSeq: number
  #closed = false
  #retries = 0
  #outbox: string[] = []
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, sessionId: string, options: AttachOptions = {}) {
    this.#client = client
    this.sessionId = sessionId
    this.#options = { reconnect: true, ...options }
    this.#lastSeq = options.afterSeq ?? 0
    // Deferred a tick so a same-tick detach (React StrictMode's dev mount) never closes a WebSocket mid-upgrade, which breaks proxies.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  on<K extends keyof SessionHandleEvents>(kind: K, listener: Listener<SessionHandleEvents[K]>): () => void {
    return this.#events.on(kind, listener)
  }

  send(text: string, attachmentIds?: string[]): void {
    this.#sendFrame({
      type: 'user_message',
      text,
      attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
    })
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'allow', updatedInput })
  }

  deny(requestId: string, message?: string, interrupt?: boolean): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'deny', message, interrupt })
  }

  interrupt(): void {
    this.#sendFrame({ type: 'interrupt' })
  }

  clearContext(): void {
    this.#sendFrame({ type: 'clear_context' })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#sendFrame({ type: 'set_permission_mode', mode })
  }

  setModel(model?: string): void {
    this.#sendFrame({ type: 'set_model', model })
  }

  sendToolCallResult(executionId: string, output: ToolExecutionOutput, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_result', executionId, output, logs })
  }

  sendToolCallError(executionId: string, reason: string, error: string, logs?: string[]): void {
    this.#sendFrame({ type: 'tool_call_error', executionId, reason, error, logs })
  }

  closeSession(): void {
    this.#sendFrame({ type: 'close' })
    this.detach()
  }

  reconnectNow(): void {
    if (this.#closed || (this.#ws && this.#ws.readyState === 1)) {
      return
    }
    clearTimeout(this.#connectTimer)
    this.#retries = 0
    this.#connect()
  }

  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  #sendFrame(frame: ClientFrame): void {
    const payload = JSON.stringify(frame)
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected)
    if (this.#ws && this.#ws.readyState === 1) {
      this.#ws.send(payload)
    } else {
      this.#outbox.push(payload)
    }
  }

  #connect(): void {
    if (this.#closed) {
      return
    }
    const ws = this.#client.openSocket(this.sessionId, this.#lastSeq, this.#options.truncateResults, this.#options.imageRefs)
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#events.emit('connectionChange', true)
      for (const payload of this.#outbox.splice(0)) {
        ws.send(payload)
      }
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#events.emit('attached', frame)
      } else if (frame.type === 'event') {
        if (frame.event.seq <= this.#lastSeq) {
          return
        }
        this.#lastSeq = frame.event.seq
        this.#events.emit('event', frame.event)
      } else if (frame.type === 'tool_call_request') {
        this.#events.emit('toolCallRequest', frame)
      } else if (frame.type === 'tool_call_canceled') {
        this.#events.emit('toolCallCanceled', { executionId: frame.executionId, reason: frame.reason })
      } else if (frame.type === 'protocol_error') {
        this.#events.emit('protocolError', frame.message)
      }
    }
    ws.onclose = () => {
      this.#events.emit('connectionChange', false)
      if (this.#closed || !this.#options.reconnect) {
        return
      }
      const delay = reconnectDelay(this.#retries++)
      this.#events.emit('reconnectAttempt', this.#retries)
      this.#connectTimer = setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {}
  }
}
