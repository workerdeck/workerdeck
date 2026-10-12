import type {
  AttachedFrame,
  ClientFrame,
  PermissionMode,
  ServerFrame,
  SessionEvent,
  ShellInfo,
  ToolCallRequestFrame,
  ToolExecutionOutput,
} from '@workerdeck/protocol'
import { chunkShellInput } from '@workerdeck/protocol'
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
  shellAttached: { shellId: string; shell: ShellInfo; cols: number; rows: number; scrollback: string }
  shellOutput: { shellId: string; data: string }
  shellDetached: { shellId: string; reason: string }
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
  #outbox: Array<{ payload: string; clientId?: string }> = []
  #unacked = new Map<string, string>()
  #acks = false
  #attachedHere = false
  #prompts = 0
  readonly #nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
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
    const clientId = `${this.#nonce}.${++this.#prompts}`
    this.#sendFrame(
      {
        type: 'user_message',
        text,
        attachmentIds: attachmentIds?.length ? attachmentIds : undefined,
        clientId,
      },
      clientId,
    )
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

  sleep(): void {
    this.#sendFrame({ type: 'sleep' })
  }

  backgroundTask(toolUseId?: string): void {
    this.#sendFrame({ type: 'background_task', toolUseId })
  }

  runShell(command: string): void {
    this.#sendFrame({ type: 'shell_command', command })
  }

  attachShell(shellId: string, size: { cols: number; rows: number }): void {
    this.#sendFrame({ type: 'shell_attach', shellId, cols: size.cols, rows: size.rows })
  }

  writeShell(shellId: string, data: string): void {
    for (const chunk of chunkShellInput(data)) {
      this.#sendFrame({ type: 'shell_input', shellId, data: chunk })
    }
  }

  resizeShell(shellId: string, size: { cols: number; rows: number }): void {
    this.#sendFrame({ type: 'shell_resize', shellId, cols: size.cols, rows: size.rows })
  }

  detachShell(shellId: string): void {
    this.#sendFrame({ type: 'shell_detach', shellId })
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

  setEffort(effort?: string): void {
    this.#sendFrame({ type: 'set_effort', effort })
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

  #sendFrame(frame: ClientFrame, clientId?: string): void {
    const payload = JSON.stringify(frame)
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected)
    if (this.#ws && this.#ws.readyState === 1) {
      this.#transmit(this.#ws, payload, clientId)
    } else {
      this.#outbox.push({ payload, clientId })
    }
  }

  // A prompt stays until the gateway acks it, so a drop before the ack resends it on the next socket.
  #transmit(ws: WebSocket, payload: string, clientId: string | undefined): void {
    ws.send(payload)
    if (clientId && (this.#acks || !this.#attachedHere)) {
      this.#unacked.set(clientId, payload)
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
      // Only a gateway known to ack runs a resent prompt once; without that knowledge a sent prompt counts as delivered.
      this.#attachedHere = false
      const resend = this.#acks ? [...this.#unacked].map(([clientId, payload]) => ({ payload, clientId })) : []
      this.#unacked.clear()
      for (const { payload, clientId } of [...resend, ...this.#outbox.splice(0)]) {
        this.#transmit(ws, payload, clientId)
      }
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#acks = frame.acks === true
        this.#attachedHere = true
        if (!this.#acks) {
          this.#unacked.clear()
        }
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
      } else if (frame.type === 'shell_attached') {
        this.#events.emit('shellAttached', {
          shellId: frame.shellId,
          shell: frame.shell,
          cols: frame.cols,
          rows: frame.rows,
          scrollback: frame.scrollback,
        })
      } else if (frame.type === 'shell_output') {
        this.#events.emit('shellOutput', { shellId: frame.shellId, data: frame.data })
      } else if (frame.type === 'shell_detached') {
        this.#events.emit('shellDetached', { shellId: frame.shellId, reason: frame.reason })
      } else if (frame.type === 'ack') {
        this.#unacked.delete(frame.clientId)
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
