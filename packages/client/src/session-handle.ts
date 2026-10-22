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
  // A past conversation of the session: a read-only socket that never moves the client's conversation token.
  conversation?: number
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
  // A prompt the gateway refused before the engine saw it (its conversation ended, a rotation was in flight): the sender's to resubmit.
  // `uncertain`: refused now, but whether an earlier attempt ran is no longer known.
  undeliveredPrompt: { clientId: string; text: string; attachmentIds?: string[]; uncertain?: true }
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
  #outbox: Array<{ frame: ClientFrame; clientId?: string }> = []
  #unacked = new Map<string, string>()
  #everConnected = false
  #attachedHere = false
  #prompts = 0
  // The conversation new commands are written for. Stamped onto a command when it is created and never rewritten, so a
  // resend after a reconnect still names the conversation it was meant for and is refused if that one has ended.
  #conversation: number | undefined
  readonly #nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  #connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(client: WorkerDeckClient, sessionId: string, options: AttachOptions = {}) {
    this.#client = client
    this.sessionId = sessionId
    this.#options = { reconnect: true, ...options }
    this.#lastSeq = options.afterSeq ?? 0
    this.#conversation = options.conversation ?? client.conversationOf(sessionId)
    // Deferred a tick so a same-tick detach (React StrictMode's dev mount) never closes a WebSocket mid-upgrade, which breaks proxies.
    this.#connectTimer = setTimeout(() => this.#connect(), 0)
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  // False until a socket has opened once: a failing first attach never reached the gateway at all.
  get everConnected(): boolean {
    return this.#everConnected
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

  // Skips the backoff wait only: a socket still in its handshake is left to finish, never doubled.
  reconnectNow(): void {
    const state = this.#ws?.readyState
    if (this.#closed || state === 1) {
      return
    }
    this.#retries = 0
    this.#events.emit('reconnectAttempt', 0)
    if (state === 0) {
      return
    }
    clearTimeout(this.#connectTimer)
    this.#connect()
  }

  detach(): void {
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#ws?.close()
    this.#ws = undefined
  }

  get conversation(): number | undefined {
    return this.#conversation
  }

  #sendFrame(frame: ClientFrame, clientId?: string): void {
    const stamped = this.#conversation === undefined ? frame : { ...frame, generation: this.#conversation }
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected). A frame with no conversation
    // yet waits for the attach that names one.
    if (this.#ws && this.#ws.readyState === 1 && (this.#attachedHere || stamped.generation !== undefined)) {
      this.#transmit(this.#ws, JSON.stringify(stamped), clientId)
    } else {
      this.#outbox.push({ frame: stamped, clientId })
    }
  }

  #flushOutbox(ws: WebSocket): void {
    for (const { frame, clientId } of this.#outbox.splice(0)) {
      const stamped =
        frame.generation === undefined && this.#conversation !== undefined ? { ...frame, generation: this.#conversation } : frame
      this.#transmit(ws, JSON.stringify(stamped), clientId)
    }
  }

  // A prompt stays until the gateway acks it, so a drop before the ack resends it on the next socket.
  #transmit(ws: WebSocket, payload: string, clientId: string | undefined): void {
    ws.send(payload)
    if (clientId) {
      this.#unacked.set(clientId, payload)
    }
  }

  #connect(): void {
    if (this.#closed) {
      return
    }
    const ws = this.#client.openSocket(
      this.sessionId,
      this.#lastSeq,
      this.#options.truncateResults,
      this.#options.imageRefs,
      this.#options.conversation,
    )
    this.#ws = ws
    let opened = false
    ws.onopen = () => {
      opened = true
      this.#everConnected = true
      this.#retries = 0
      this.#events.emit('connectionChange', true)
      this.#attachedHere = false
      const resend = [...this.#unacked]
      this.#unacked.clear()
      for (const [clientId, payload] of resend) {
        this.#transmit(ws, payload, clientId)
      }
      if (this.#outbox.every(({ frame }) => frame.generation !== undefined)) {
        this.#flushOutbox(ws)
      }
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#attachedHere = true
        const conversation = (frame.session as Partial<AttachedFrame['session']> | undefined)?.conversation
        if (conversation !== undefined && this.#options.conversation === undefined) {
          this.#conversation = conversation
          this.#client.noteConversation(this.sessionId, conversation)
        }
        this.#flushOutbox(ws)
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
        const payload = this.#unacked.get(frame.clientId)
        this.#unacked.delete(frame.clientId)
        if ((frame.notDelivered || frame.uncertain) && payload !== undefined) {
          const sent = JSON.parse(payload) as Extract<ClientFrame, { type: 'user_message' }>
          this.#events.emit('undeliveredPrompt', {
            clientId: frame.clientId,
            text: sent.text,
            ...(sent.attachmentIds ? { attachmentIds: sent.attachmentIds } : {}),
            ...(frame.uncertain ? { uncertain: true as const } : {}),
          })
        }
      } else if (frame.type === 'protocol_error') {
        this.#events.emit('protocolError', frame.message)
      }
    }
    ws.onclose = () => {
      if (opened) {
        this.#events.emit('connectionChange', false)
      }
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
