import { WebSocket as NodeWebSocket } from 'ws'
import type { HostStore, GatewayHost } from './hosts.ts'
import { apiUrl } from './hosts.ts'
import type { TransportToHost, TransportToWebview, WebviewToHost } from './bridge-protocol.ts'

export class WebviewTransportHost {
  readonly #store: HostStore
  readonly #post: (msg: TransportToWebview) => void
  readonly #onFrame: ((text: string) => void) | undefined
  readonly #sockets = new Map<number, InstanceType<typeof NodeWebSocket>>()
  readonly #aborts = new Map<number, AbortController>()

  constructor(store: HostStore, post: (msg: TransportToWebview) => void, onFrame?: (text: string) => void) {
    this.#store = store
    this.#post = post
    this.#onFrame = onFrame
  }

  async handle(msg: WebviewToHost): Promise<boolean> {
    switch (msg.kind) {
      case 'wd-fetch': {
        await this.#handleFetch(msg)
        return true
      }
      case 'wd-fetch-abort': {
        this.#aborts.get(msg.id)?.abort()
        return true
      }
      case 'wd-ws-open': {
        await this.#handleWsOpen(msg.id, msg.url)
        return true
      }
      case 'wd-ws-send': {
        this.#sockets.get(msg.id)?.send(msg.data)
        return true
      }
      case 'wd-ws-close': {
        this.#sockets.get(msg.id)?.close(msg.code, msg.reason)
        return true
      }
      default: {
        return false
      }
    }
  }

  async #gatewayFor(url: string): Promise<{ host: GatewayHost; headers: Record<string, string> } | undefined> {
    for (const host of this.#store.all()) {
      const base = apiUrl(host)
      if (!base) {
        continue
      }
      const wsBase = base.replace(/^http/, 'ws')
      if (url.startsWith(base + '/') || url === base || url.startsWith(wsBase + '/')) {
        return { host, headers: await this.#store.authHeaders(host.id) }
      }
    }
    return undefined
  }

  async #handleFetch(msg: Extract<TransportToHost, { kind: 'wd-fetch' }>): Promise<void> {
    const gateway = await this.#gatewayFor(msg.url)
    if (!gateway) {
      this.#post({ kind: 'wd-fetch-result', id: msg.id, ok: false, error: 'not a registered gateway' })
      return
    }
    const abort = new AbortController()
    this.#aborts.set(msg.id, abort)
    try {
      const res = await fetch(msg.url, {
        method: msg.method,
        headers: { ...Object.fromEntries(msg.headers), ...gateway.headers },
        body: msg.bodyB64 !== undefined ? Buffer.from(msg.bodyB64, 'base64') : undefined,
        signal: abort.signal,
      })
      const body = Buffer.from(await res.arrayBuffer())
      this.#post({
        kind: 'wd-fetch-result',
        id: msg.id,
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
        bodyB64: body.toString('base64'),
      })
    } catch (err) {
      this.#post({
        kind: 'wd-fetch-result',
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      this.#aborts.delete(msg.id)
    }
  }

  async #handleWsOpen(id: number, url: string): Promise<void> {
    const gateway = await this.#gatewayFor(url)
    if (!gateway) {
      this.#post({ kind: 'wd-ws-event', id, event: 'error', message: 'not a registered gateway' })
      this.#post({ kind: 'wd-ws-event', id, event: 'close', code: 4403, reason: 'refused' })
      return
    }
    const socket = new NodeWebSocket(url, { headers: gateway.headers })
    this.#sockets.set(id, socket)
    socket.on('open', () => this.#post({ kind: 'wd-ws-event', id, event: 'open' }))
    socket.on('message', (data) => {
      const text = typeof data === 'string' ? data : data.toString()
      this.#onFrame?.(text)
      this.#post({ kind: 'wd-ws-event', id, event: 'message', data: text })
    })
    socket.on('close', (code, reason) => {
      this.#sockets.delete(id)
      this.#post({ kind: 'wd-ws-event', id, event: 'close', code, reason: reason.toString() })
    })
    socket.on('error', (err) => {
      this.#post({ kind: 'wd-ws-event', id, event: 'error', message: err.message })
    })
  }

  dispose(): void {
    for (const socket of this.#sockets.values()) {
      socket.close()
    }
    this.#sockets.clear()
    for (const abort of this.#aborts.values()) {
      abort.abort()
    }
    this.#aborts.clear()
  }
}
