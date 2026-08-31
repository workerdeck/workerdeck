import { appendFileSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'

export const CODEX_TRACE_ENV = 'WORKERDECK_CODEX_TRACE'

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

export class JsonRpcStdioConnection {
  #output: Writable
  #nextId = 1
  #pending = new Map<number, Pending>()
  #buffer = ''
  #closed = false
  #notificationHandler: ((method: string, params: unknown) => void) | undefined
  #trace: string | undefined
  #requestHandler: ((method: string, params: unknown, id: string | number) => Promise<unknown>) | undefined

  constructor(options: { input: Readable; output: Writable }) {
    this.#output = options.output
    this.#trace = process.env[CODEX_TRACE_ENV] || undefined
    options.input.on('data', (chunk: Buffer | string) => this.#feed(String(chunk)))
    // Stream errors surface via the process wrapper's exit handling; this only prevents an unhandled crash between the two.
    options.input.on('error', () => {})
    options.output.on('error', () => {})
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) {
      return Promise.reject(new Error(`codex app-server is closed (${method})`))
    }
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject })
      this.#write({ id, method, ...(params === undefined ? {} : { params }) })
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) {
      return
    }
    this.#write({ method, ...(params === undefined ? {} : { params }) })
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.#notificationHandler = handler
  }

  onRequest(handler: (method: string, params: unknown, id: string | number) => Promise<unknown>): void {
    this.#requestHandler = handler
  }

  fail(message: string): void {
    if (this.#closed) {
      return
    }
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
      if (!line) {
        continue
      }
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue // never let one garbled line kill the session
      }
      this.#traceLine(message)
      this.#dispatch(message)
    }
  }

  #traceLine(message: Record<string, unknown>): void {
    if (!this.#trace) {
      return
    }
    const method = message.method
    if (typeof method !== 'string') {
      return
    }
    // account/* and login* are the one place this protocol carries a masked credential fragment.
    if (method.startsWith('account/') || method.startsWith('login')) {
      return
    }
    try {
      appendFileSync(this.#trace, JSON.stringify(message) + '\n')
    } catch {
      // Unwritable path, full disk: tracing is never worth failing a session.
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    const { id, method } = message
    if (typeof method === 'string') {
      if (id === undefined || id === null) {
        this.#notificationHandler?.(method, message.params)
        return
      }
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
    if (id === undefined || id === null) {
      return
    }
    const pending = this.#pending.get(id as number)
    if (!pending) {
      return
    }
    this.#pending.delete(id as number)
    if (message.error !== undefined && message.error !== null) {
      const error = message.error as { code?: number; message?: string }
      pending.reject(new JsonRpcError(error.code ?? -32603, error.message ?? `request '${pending.method}' failed`))
      return
    }
    pending.resolve(message.result)
  }
}
