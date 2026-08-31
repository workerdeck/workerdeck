import type { SessionInfo, SessionNotification, SessionWebhookConfig } from '@workerdeck/protocol'
import type { Runner } from '@workerdeck/core'

export type SessionNotificationOptions = {
  webhook?: SessionWebhookConfig
  onNotification?: (notification: SessionNotification) => void
  attempts?: number
  retryDelayMs?: number
  decorateInfo?: (info: SessionInfo) => SessionInfo
}

export class SessionNotifier {
  readonly #options: SessionNotificationOptions
  readonly #chains = new Map<string, Promise<void>>()

  constructor(options: SessionNotificationOptions) {
    this.#options = options
  }

  get idle(): boolean {
    return !this.#options.webhook && !this.#options.onNotification
  }

  watch(runner: Runner, afterSeq = runner.info().lastSeq): void {
    if (this.idle) {
      return
    }
    runner.subscribe((event) => {
      switch (event.type) {
        case 'permission_requested': {
          this.#emit(runner, event.seq, event.ts, {
            type: 'permission_requested',
            preview: event.request.title ?? event.request.toolName,
            request: event.request,
          })
          return
        }
        case 'turn_result': {
          this.#emit(runner, event.seq, event.ts, {
            type: 'turn_completed',
            preview: event.isError ? event.errors?.join('\n') : event.result,
            result: {
              isError: event.isError,
              durationMs: event.durationMs,
              numTurns: event.numTurns,
              totalCostUsd: event.totalCostUsd,
            },
          })
          return
        }
        case 'session_error': {
          this.#emit(runner, event.seq, event.ts, {
            type: 'session_error',
            preview: event.message,
          })
          return
        }
        case 'session_closed': {
          this.#emit(runner, event.seq, event.ts, {
            type: 'session_closed',
            reason: event.reason,
          })
          return
        }
        default: {
          return
        }
      }
    }, afterSeq)
  }

  #emit(runner: Runner, seq: number, ts: number, body: Omit<SessionNotification, 'sessionId' | 'session' | 'seq' | 'ts'>): void {
    queueMicrotask(() => this.#send(runner, seq, ts, body))
  }

  #send(runner: Runner, seq: number, ts: number, body: Omit<SessionNotification, 'sessionId' | 'session' | 'seq' | 'ts'>): void {
    const webhook = this.#options.webhook
    const wanted = !webhook?.events || webhook.events.includes(body.type)
    if (!webhook && !this.#options.onNotification) {
      return
    }

    const notification: SessionNotification = {
      ...body,
      sessionId: runner.id,
      session: (this.#options.decorateInfo ?? ((info) => info))(runner.info()),
      seq,
      ts,
    }

    try {
      this.#options.onNotification?.(notification)
    } catch {}

    if (!webhook || !wanted) {
      return
    }
    const previous = this.#chains.get(runner.id) ?? Promise.resolve()
    const next = previous.then(() => this.#deliver(webhook, notification))
    this.#chains.set(runner.id, next)
    void next.then(() => {
      if (this.#chains.get(runner.id) === next) {
        this.#chains.delete(runner.id)
      }
    })
  }

  async #deliver(webhook: SessionWebhookConfig, notification: SessionNotification): Promise<void> {
    const attempts = this.#options.attempts ?? 3
    const baseDelay = this.#options.retryDelayMs ?? 500
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...webhook.headers },
          body: JSON.stringify(notification),
        })
        if (res.ok) {
          return
        }
      } catch {}
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt))
      }
    }
  }
}
