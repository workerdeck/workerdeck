import type { HostToWebview, TransportToWebview, WebviewToHost } from '../src/bridge-protocol.ts'

/**
 * Webview half of the transport bridge: a fetch and a WebSocket riding `postMessage` to the
 * extension host, handed to real `WorkerDeckClient`s as `fetchImpl` / `WebSocketImpl`. Kinds in
 * `replayKinds` have their last value replayed to late subscribers, because the host answers our
 * `wd-ready` (sent at module load) before React has mounted and listened.
 */

type VsCodeApi = {
  postMessage(msg: unknown): void
  /** Webview-local persistence: survives the view being torn down and rebuilt
   * (VS Code does that freely), which `useState` does not. */
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi

let nextId = 1

export type AppHostMessage = Exclude<HostToWebview, TransportToWebview>

export class Bridge {
  readonly #vscode: VsCodeApi
  readonly #pendingFetches = new Map<number, { resolve: (res: Response) => void; reject: (err: Error) => void }>()
  readonly #sockets = new Map<number, BridgedWebSocket>()
  readonly #hostListeners = new Set<(msg: AppHostMessage) => void>()
  readonly #replayKinds: readonly string[]
  readonly #lastByKind = new Map<string, AppHostMessage>()

  constructor(replayKinds: readonly string[] = []) {
    this.#replayKinds = replayKinds
    this.#vscode = acquireVsCodeApi()
    window.addEventListener('message', (e: MessageEvent<HostToWebview>) => this.#onMessage(e.data))
    this.post({ kind: 'wd-ready' })
  }

  post(msg: WebviewToHost): void {
    this.#vscode.postMessage(msg)
  }

  /** The webview's own persisted state (view preferences, not session data). */
  getState<T>(): T | undefined {
    return this.#vscode.getState() as T | undefined
  }

  setState<T>(state: T): void {
    this.#vscode.setState(state)
  }

  onHostMessage(listener: (msg: AppHostMessage) => void): () => void {
    this.#hostListeners.add(listener)
    for (const kind of this.#replayKinds) {
      const last = this.#lastByKind.get(kind)
      if (last) {
        listener(last)
      }
    }
    return () => this.#hostListeners.delete(listener)
  }

  #onMessage(msg: HostToWebview): void {
    switch (msg.kind) {
      case 'wd-fetch-result': {
        const pending = this.#pendingFetches.get(msg.id)
        if (!pending) {
          return
        }
        this.#pendingFetches.delete(msg.id)
        if (!msg.ok) {
          // Reject like fetch does on network failure: a TypeError.
          pending.reject(new TypeError(msg.error))
          return
        }
        // A real Response — .json()/.text()/.blob()/.ok all behave exactly.
        // Bodyless statuses refuse a body in the constructor.
        const bodyless = msg.status === 204 || msg.status === 205 || msg.status === 304
        pending.resolve(
          new Response(bodyless ? null : bytesFromB64(msg.bodyB64), {
            status: msg.status,
            statusText: msg.statusText,
            headers: msg.headers,
          }),
        )
        return
      }
      case 'wd-ws-event': {
        this.#sockets.get(msg.id)?.dispatch(msg)
        return
      }
      default: {
        if (this.#replayKinds.includes(msg.kind)) {
          this.#lastByKind.set(msg.kind, msg)
        }
        for (const listener of this.#hostListeners) {
          listener(msg)
        }
        return
      }
    }
  }

  /** `fetchImpl` for `WorkerDeckClient`. */
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const id = nextId++
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? 'GET'
    const headers: [string, string][] = init?.headers ? [...new Headers(init.headers as HeadersInit).entries()] : []
    const bodyB64 = init?.body === undefined || init?.body === null ? undefined : await bodyToB64(init.body)
    const promise = new Promise<Response>((resolve, reject) => {
      this.#pendingFetches.set(id, { resolve, reject })
    })
    if (init?.signal) {
      const signal = init.signal
      if (signal.aborted) {
        this.#pendingFetches.delete(id)
        throw signal.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')
      }
      signal.addEventListener('abort', () => this.post({ kind: 'wd-fetch-abort', id }), { once: true })
    }
    this.post({ kind: 'wd-fetch', id, url, method, headers, bodyB64 })
    return promise
  }

  /** `WebSocketImpl` for `WorkerDeckClient` — bound to this bridge instance. */
  get WebSocketImpl(): typeof WebSocket {
    // The client uses: constructor(url), readyState, send, close, and the four
    // on* handlers. BridgedWebSocket implements exactly that; the cast hands it
    // over under the lib.dom type.
    const make = (url: string | URL) => new BridgedWebSocket(this, String(url))
    const ctor = function (this: unknown, url: string | URL) {
      return make(url)
    }
    return ctor as unknown as typeof WebSocket
  }

  registerSocket(id: number, socket: BridgedWebSocket): void {
    this.#sockets.set(id, socket)
  }

  unregisterSocket(id: number): void {
    this.#sockets.delete(id)
  }
}

export class BridgedWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly #bridge: Bridge
  readonly #id: number
  readonly url: string
  readyState = BridgedWebSocket.CONNECTING

  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null

  constructor(bridge: Bridge, url: string) {
    this.#bridge = bridge
    this.#id = nextId++
    this.url = url
    bridge.registerSocket(this.#id, this)
    bridge.post({ kind: 'wd-ws-open', id: this.#id, url })
  }

  send(data: string): void {
    if (this.readyState !== BridgedWebSocket.OPEN) {
      return
    }
    this.#bridge.post({ kind: 'wd-ws-send', id: this.#id, data })
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === BridgedWebSocket.CLOSED) {
      return
    }
    this.readyState = BridgedWebSocket.CLOSING
    this.#bridge.post({ kind: 'wd-ws-close', id: this.#id, code, reason })
  }

  dispatch(
    msg:
      | { event: 'open' }
      | { event: 'message'; data: string }
      | { event: 'close'; code?: number; reason?: string }
      | { event: 'error'; message?: string },
  ): void {
    switch (msg.event) {
      case 'open': {
        this.readyState = BridgedWebSocket.OPEN
        this.onopen?.({ type: 'open' })
        return
      }
      case 'message': {
        this.onmessage?.(new MessageEvent('message', { data: msg.data }))
        return
      }
      case 'error': {
        this.onerror?.({ type: 'error', message: msg.message })
        return
      }
      case 'close': {
        this.readyState = BridgedWebSocket.CLOSED
        this.#bridge.unregisterSocket(this.#id)
        this.onclose?.({ type: 'close', code: msg.code, reason: msg.reason })
        return
      }
    }
  }
}

const bodyToB64 = async (body: BodyInit): Promise<string> => {
  if (typeof body === 'string') {
    return b64FromBytes(new TextEncoder().encode(body))
  }
  if (body instanceof Blob) {
    return b64FromBytes(new Uint8Array(await body.arrayBuffer()))
  }
  if (body instanceof ArrayBuffer) {
    return b64FromBytes(new Uint8Array(body))
  }
  if (ArrayBuffer.isView(body)) {
    return b64FromBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength))
  }
  throw new TypeError('unsupported request body type for the workerdeck bridge')
}

const b64FromBytes = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

const bytesFromB64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
