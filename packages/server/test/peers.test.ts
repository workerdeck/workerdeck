import { describe, expect, it } from 'vitest'
import type { Runner, SendMessageOptions } from '@workerdeck/core'
import type { PermissionRequest, SessionEvent, SessionEventBody, SessionInfo, SessionStatus } from '@workerdeck/protocol'
import { ProjectInfoService } from '../src/services/project-info.ts'
import { SessionRegistry } from '../src/services/registry.ts'
import { createPeerService } from '../src/services/peers.ts'
import type { LateBoundRefs } from '../src/options.ts'

type Sent = { text: string; options?: SendMessageOptions }

class PeerRunner implements Runner {
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

function rig(options?: { perMinute?: number; maxHops?: number; maxMessageChars?: number }) {
  const registry = new SessionRegistry()
  const refs: LateBoundRefs = { registry }
  const service = createPeerService({ refs, projects: new ProjectInfoService(), options })
  registry.observe((runner) => service.watch(runner))
  const add = (runner: PeerRunner) => {
    registry.register(runner)
    return runner
  }
  return { registry, service, add }
}

describe('peer service: visibility', () => {
  it("lists every other session the sender's scope can see, never itself", async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { scope: { tenant: 't1' } }))
    add(new PeerRunner('b', { scope: { tenant: 't1' }, title: 'Fix auth' }))
    add(new PeerRunner('c', { scope: { tenant: 't2' } }))
    add(new PeerRunner('d'))
    expect((await service.list('a')).map((row) => row.id)).toEqual(['b'])
    expect((await service.list('d')).map((row) => row.id).sort()).toEqual(['a', 'b', 'c'])
    expect((await service.list('a'))[0]).toMatchObject({ id: 'b', title: 'Fix auth', engine: 'claude', status: 'idle' })
  })

  it('peek and send answer "no such session" for a peer outside the sender\'s scope', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { scope: { tenant: 't1' } }))
    const c = add(new PeerRunner('c', { scope: { tenant: 't2' } }))
    expect(await service.peek('a', 'c')).toBeUndefined()
    expect(await service.send('a', 'c', 'hi')).toEqual({ delivered: false, reason: 'no such session: c' })
    expect(c.sent).toEqual([])
  })

  it('refuses an unknown sender outright', async () => {
    const { service } = rig()
    await expect(service.list('ghost')).rejects.toThrow('unknown sender session: ghost')
  })
})

describe('peer service: peek', () => {
  it('reads status, pending approvals and the recent transcript without touching the runner', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a'))
    const b = add(new PeerRunner('b', { status: 'awaiting_approval' }))
    b.emit({ type: 'user_message', message: { role: 'user', content: 'ship it' }, parentToolUseId: null })
    b.emit({
      type: 'assistant_message',
      message: { role: 'assistant', content: [{ type: 'text', text: 'running tests' }] },
      parentToolUseId: null,
      uuid: 'x',
    })
    b.pendingApprovals = [{ id: 'p1', toolName: 'Bash', input: {}, toolUseId: 't1', title: 'Run pnpm test' }]
    const peek = await service.peek('a', 'b')
    expect(peek).toMatchObject({ id: 'b', live: true, status: 'awaiting_approval', pendingApprovals: ['Run pnpm test'] })
    expect(peek!.recent).toEqual(['user: ship it', 'assistant: running tests'])
    expect((await service.peek('a', 'b', { recent: 1 }))!.recent).toEqual(['assistant: running tests'])
    expect((await service.peek('a', 'b', { recent: 0 }))!.recent).toEqual([])
    expect(b.sent).toEqual([])
  })
})

describe('peer service: send', () => {
  it('delivers through sendMessage with a peer origin naming the sender, and says whether the peer was busy', async () => {
    const { service, add } = rig()
    add(new PeerRunner('a', { title: 'Auth fix' }))
    const b = add(new PeerRunner('b'))
    expect(await service.send('a', 'b', 'hello')).toEqual({ delivered: true, sessionId: 'b', queued: false })
    expect(b.sent).toEqual([
      { text: 'hello', options: { origin: { kind: 'peer', sessionId: 'a', name: 'Auth fix', engine: 'claude', hops: ['a'] } } },
    ])
    b.status = 'running'
    expect(await service.send('a', 'b', 'more')).toMatchObject({ delivered: true, queued: true })
  })

  it('refuses self, oversize and closed targets, and reports a runner that throws', async () => {
    const { service, add } = rig({ maxMessageChars: 10 })
    add(new PeerRunner('a'))
    const b = add(new PeerRunner('b'))
    expect(await service.send('a', 'a', 'hi')).toMatchObject({ delivered: false, reason: expect.stringContaining('this session') })
    expect(await service.send('a', 'b', 'x'.repeat(11))).toMatchObject({ delivered: false, reason: expect.stringContaining('limit is 10') })
    b.status = 'closed'
    expect(await service.send('a', 'b', 'hi')).toEqual({ delivered: false, reason: 'session b is closed' })
    b.status = 'idle'
    b.sendMessage = () => {
      throw new Error('session is parked')
    }
    expect(await service.send('a', 'b', 'hi')).toEqual({ delivered: false, reason: 'session is parked' })
  })

  it('rate-limits one sender to one target per minute', async () => {
    const { service, add } = rig({ perMinute: 2 })
    add(new PeerRunner('a'))
    add(new PeerRunner('b'))
    add(new PeerRunner('c'))
    expect((await service.send('a', 'b', '1')).delivered).toBe(true)
    expect((await service.send('a', 'b', '2')).delivered).toBe(true)
    expect(await service.send('a', 'b', '3')).toMatchObject({ delivered: false, reason: expect.stringContaining('rate limit') })
    expect((await service.send('a', 'c', '4')).delivered).toBe(true)
  })

  it('bounds an agent-to-agent exchange by hops, and a human turn resets the chain', async () => {
    const { service, add } = rig({ maxHops: 3, perMinute: 100 })
    const a = add(new PeerRunner('a'))
    const b = add(new PeerRunner('b'))
    expect((await service.send('a', 'b', '1')).delivered).toBe(true)
    expect(b.sent.at(-1)!.options!.origin!.hops).toEqual(['a'])
    expect((await service.send('b', 'a', '2')).delivered).toBe(true)
    expect(a.sent.at(-1)!.options!.origin!.hops).toEqual(['a', 'b'])
    expect((await service.send('a', 'b', '3')).delivered).toBe(true)
    expect(b.sent.at(-1)!.options!.origin!.hops).toEqual(['a', 'b', 'a'])
    expect(await service.send('b', 'a', '4')).toMatchObject({ delivered: false, reason: expect.stringContaining('without a person') })

    b.emit({ type: 'user_message', message: { role: 'user', content: 'carry on' }, parentToolUseId: null })
    expect((await service.send('b', 'a', '5')).delivered).toBe(true)
    expect(a.sent.at(-1)!.options!.origin!.hops).toEqual(['b'])
  })

  it('wakes a dormant target through parking when one is wired', async () => {
    const registry = new SessionRegistry()
    const dormant = new PeerRunner('d')
    const info: SessionInfo = { ...dormant.info(), status: 'parked' }
    const refs: LateBoundRefs = {
      registry,
      parking: {
        listInfo: async () => [info],
        get: async (id: string) => (id === 'd' ? { id, info } : null),
        ensureLive: async (id: string) => (id === 'd' ? (registry.register(dormant), dormant) : registry.get(id)),
      } as unknown as LateBoundRefs['parking'],
    }
    const service = createPeerService({ refs, projects: new ProjectInfoService() })
    registry.register(new PeerRunner('a'))
    expect((await service.list('a')).map((row) => row.id)).toEqual(['d'])
    expect(await service.peek('a', 'd')).toMatchObject({ id: 'd', live: false, recent: [] })
    expect(await service.send('a', 'd', 'wake up')).toEqual({ delivered: true, sessionId: 'd', queued: false })
    expect(dormant.sent).toEqual([
      { text: 'wake up', options: { origin: { kind: 'peer', sessionId: 'a', engine: 'claude', hops: ['a'] } } },
    ])
  })
})
