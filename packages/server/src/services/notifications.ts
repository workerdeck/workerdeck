import type { SessionInfo, SessionNotification, SessionWebhookConfig } from '@workerdeck/protocol'
import type { Runner } from '@workerdeck/core'

export type SessionNotificationOptions = {
  /** POST target for every notification. */
  webhook?: SessionWebhookConfig
  /** Local observer, invoked for every notification whether or not a webhook is
   * configured — the in-process seam a host (or the CLI's APNs forwarder) hooks.
   * Unfiltered: `webhook.events` narrows POST deliveries, not this. */
  onNotification?: (notification: SessionNotification) => void
  /** Delivery attempts per notification (exponential backoff). Default 3. */
  attempts?: number
  /** Initial backoff between attempts. Default 500ms. */
  retryDelayMs?: number
  /** Gateway wiring, not a host option: the serve-time `SessionInfo` decoration
   * (project identity today), so a webhook or push consumer reads the same
   * record every REST caller does. The assembly supplies it; identity when
   * absent. */
  decorateInfo?: (info: SessionInfo) => SessionInfo
}

/**
 * Turns session events into the handful of notifications a human away from the
 * screen cares about, and delivers them to a webhook and/or a local observer.
 *
 * This is the *primitive*, deliberately transport-agnostic: the server stays
 * credential-free and knows nothing about APNs, Slack or email. Turning a
 * notification into a push is a forwarder's job (the turnkey CLI's), and one that
 * needs credentials, so it does not live here.
 *
 * Delivery is best-effort and ordered per session, mirroring the job queue's
 * webhook behaviour — a consumer that missed one can always attach to the session
 * WS with `afterSeq` and see the truth.
 */
export class SessionNotifier {
  readonly #options: SessionNotificationOptions
  /** Per-session delivery chain, so a session's notifications arrive in order. */
  readonly #chains = new Map<string, Promise<void>>()

  constructor(options: SessionNotificationOptions) {
    this.#options = options
  }

  /** True when nothing is listening — lets the caller skip subscribing at all. */
  get idle(): boolean {
    return !this.#options.webhook && !this.#options.onNotification
  }

  /**
   * Subscribe to a runner for its lifetime.
   *
   * `afterSeq` defaults to whatever the runner has already emitted, which is what
   * makes this safe on a *rehydrated* session: `subscribe` replays the log from
   * `afterSeq`, so subscribing at 0 to a session rebuilt from a park would
   * re-announce every permission request it ever made.
   */
  watch(runner: Runner, afterSeq = runner.info().lastSeq): void {
    if (this.idle) return
    runner.subscribe((event) => {
      switch (event.type) {
        case 'permission_requested':
          this.#emit(runner, event.seq, event.ts, {
            type: 'permission_requested',
            preview: event.request.title ?? event.request.toolName,
            request: event.request,
          })
          return
        case 'turn_result':
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
        case 'session_error':
          this.#emit(runner, event.seq, event.ts, {
            type: 'session_error',
            preview: event.message,
          })
          return
        case 'session_closed':
          this.#emit(runner, event.seq, event.ts, {
            type: 'session_closed',
            reason: event.reason,
          })
          return
        default:
          return
      }
    }, afterSeq)
  }

  #emit(
    runner: Runner,
    seq: number,
    ts: number,
    body: Omit<SessionNotification, 'sessionId' | 'session' | 'seq' | 'ts'>,
  ): void {
    // A microtask late, deliberately. Listeners run *inside* the emit, before the
    // runner has applied what the event means — `session_closed` is delivered
    // while the status still says 'starting', `session_error` before 'failed'.
    // The event supplies seq/ts, so identity and ordering are unaffected; only the
    // snapshot moves, and it moves to the truth.
    queueMicrotask(() => this.#send(runner, seq, ts, body))
  }

  #send(
    runner: Runner,
    seq: number,
    ts: number,
    body: Omit<SessionNotification, 'sessionId' | 'session' | 'seq' | 'ts'>,
  ): void {
    const webhook = this.#options.webhook
    const wanted = !webhook?.events || webhook.events.includes(body.type)
    if (!webhook && !this.#options.onNotification) return

    // `info()` is read here, not at delivery time: the snapshot must describe the
    // session as the event left it, not as it is after three retries.
    const notification: SessionNotification = {
      ...body,
      sessionId: runner.id,
      session: (this.#options.decorateInfo ?? ((info) => info))(runner.info()),
      seq,
      ts,
    }

    try {
      this.#options.onNotification?.(notification)
    } catch {
      // An observer that throws must not take the session down with it.
    }

    if (!webhook || !wanted) return
    const previous = this.#chains.get(runner.id) ?? Promise.resolve()
    const next = previous.then(() => this.#deliver(webhook, notification))
    this.#chains.set(runner.id, next)
    // Drop the chain once it drains, so a long-lived server doesn't accumulate one
    // resolved promise per session it ever ran.
    void next.then(() => {
      if (this.#chains.get(runner.id) === next) this.#chains.delete(runner.id)
    })
  }

  /**
   * Best-effort POST with exponential backoff. Deliberately a near-copy of the
   * queue's job-webhook delivery rather than a shared helper: the two channels
   * have different payloads and different consumers, and coupling them would mean
   * a change to job deliveries silently changing session deliveries.
   */
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
        if (res.ok) return
      } catch {
        // network error — retry below
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt))
      }
    }
  }
}
