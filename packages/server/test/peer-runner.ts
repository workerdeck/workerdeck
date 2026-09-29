import type { Runner, SendMessageOptions } from '@workerdeck/core'
import type { PermissionRequest, SessionEvent, SessionEventBody, SessionInfo, SessionStatus } from '@workerdeck/protocol'

export type Sent = { text: string; options?: SendMessageOptions }

export class PeerRunner implements Runner {
  readonly id: string
  readonly sent: Sent[] = []
  pendingApprovals: PermissionRequest[] = []
  status: SessionStatus = 'idle'
  scope: Record<string, string> | undefined
  title: string | undefined
  events: SessionEvent[] = []
  #listeners = new Set<(event: SessionEvent) => void>()
  #seq = 0

  constructor(id: string, opts: { scope?: Record<string, string>; title?: string; status?: SessionStatus } = {}) {
    this.id = id
    this.scope = opts.scope
    this.title = opts.title
    this.status = opts.status ?? 'idle'
  }

  async start(): Promise<void> {}
  info(): SessionInfo {
    return {
      id: this.id,
      status: this.status,
      cwd: `/work/${this.id}`,
      engine: 'claude',
      createdAt: 1,
      lastSeq: this.#seq,
      pendingPermissionCount: this.pendingApprovals.length,
      scope: this.scope,
      title: this.title,
      lastActivityAt: this.#seq,
    }
  }
  subscribe(listener: (event: SessionEvent) => void, afterSeq = 0): () => void {
    for (const event of this.events) {
      if (event.seq > afterSeq) {
        listener(event)
      }
    }
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }
  emit(body: SessionEventBody): void {
    const event = { ...body, seq: ++this.#seq, ts: this.#seq } as SessionEvent
    this.events.push(event)
    for (const listener of this.#listeners) {
      listener(event)
    }
  }
  sendMessage(text: string, _attachments?: unknown, options?: SendMessageOptions): void {
    if (this.status === 'closed') {
      throw new Error('session is closed')
    }
    this.sent.push({ text, options })
  }
  setTitle(): void {}
  resolvePermission(): boolean {
    return false
  }
  async interrupt(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  fail(): void {}
  close(): void {}
}
