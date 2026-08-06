import type { Readable, Writable } from 'node:stream'

/**
 * A JSON-RPC error response from the peer, or one we return to it. `code`
 * follows the JSON-RPC 2.0 reserved ranges (-32601 = method not found).
 */
export class JsonRpcError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'JsonRpcError'
    this.code = code
  }
}

type Pending = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/**
 * JSON-RPC over a `codex app-server` child's stdio: **newline-delimited JSON**,
 * one message per line, and — verified against 0.146.0 — an envelope *without*
 * the `jsonrpc: "2.0"` field (`{id, method, params}` / `{id, result}` /
 * `{id, error}`; the binary's own schema marks only those required). Server→
 * client notifications additionally carry a top-level `emittedAtMs`, ignored
 * here.
 *
 * Transport only: no method knowledge, no process ownership. The process
 * wrapper (`process.ts`) owns the child and calls {@link fail} when it dies so
 * every in-flight request rejects instead of hanging.
 */
export class JsonRpcStdioConnection {
  #output: Writable
  #nextId = 1
  #pending = new Map<number, Pending>()
  #buffer = ''
  #closed = false
  #notificationHandler: ((method: string, params: unknown) => void) | undefined
  #requestHandler:
    | ((method: string, params: unknown, id: string | number) => Promise<unknown>)
    | undefined

  constructor(options: { input: Readable; output: Writable }) {
    this.#output = options.output
    options.input.on('data', (chunk: Buffer | string) => this.#feed(String(chunk)))
    // Stream errors surface via the process wrapper's exit handling; swallowing
    // here just prevents an unhandled 'error' crash between the two.
    options.input.on('error', () => {})
    options.output.on('error', () => {})
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error(`codex app-server is closed (${method})`))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject })
      this.#write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#notificationHandler = handler
  }

  onRequest(handler: (method: string, params: unknown, id: string | number) => Promise<unknown>): void {
    this.#requestHandler = handler
  }

  /** Reject everything in flight and refuse new traffic — the child is gone
   * (or the session is over). Idempotent. */
  fail(message: string): void {
    if (this.#closed) return
    this.#closed = true
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      entry.reject(new Error(`${message} (awaiting ${entry.method})`))
    }
  }

  #write(payload: object): void {
    try {
      this.#output.write(JSON.stringify(payload) + '\n')
    } catch {
      // A broken pipe races the exit event; the wrapper's fail() explains it.
    }
  }

  #feed(chunk: string): void {
    this.#buffer += chunk
    let newline: number
    while ((newline = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, newline).trim()
      this.#buffer = this.#buffer.slice(newline + 1)
      if (!line) continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // never let one garbled line kill the session
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    const { id, method } = message
    if (typeof method === 'string') {
      if (id === undefined || id === null) {
        this.#notificationHandler?.(method, message.params)
        return
      }
      // Server→client request: the handler's resolution is the response. No
      // handler (or a throw) becomes a JSON-RPC error, never a hang — an
      // unanswered approval would wedge the turn.
      const respond = (payload: object) => this.#write({ id: id as string | number, ...payload })
      const handler = this.#requestHandler
      if (!handler) {
        respond({ error: { code: -32601, message: `no handler for server request '${method}'` } })
        return
      }
      handler(method, message.params, id as string | number).then(
        (result) => respond({ result: result ?? {} }),
        (error: unknown) =>
          respond({
            error: {
              code: error instanceof JsonRpcError ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      )
      return
    }
    if (id === undefined || id === null) return
    const pending = this.#pending.get(id as number)
    if (!pending) return
    this.#pending.delete(id as number)
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { code?: number; message?: string }
      pending.reject(
        new JsonRpcError(error.code ?? -32603, error.message ?? `request '${pending.method}' failed`),
      )
      return
    }
    pending.resolve(message.result)
  }
}
