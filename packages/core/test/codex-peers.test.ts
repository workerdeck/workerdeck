import { describe, expect, it, vi } from 'vitest'
import { CodexRunner, type PeerDirectory } from '../src/index.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

function directory(): PeerDirectory & { sent: Array<{ from: string; to: string; text: string }> } {
  const sent: Array<{ from: string; to: string; text: string }> = []
  return {
    sent,
    list: async () => [{ id: 'b', status: 'idle', cwd: '/b', pendingPermissionCount: 0 }],
    peek: async () => undefined,
    send: async (from, to, text) => {
      sent.push({ from, to, text })
      return { delivered: true, sessionId: to, queued: true }
    },
  }
}

function threadStart(peer: ReturnType<typeof scriptedPeer>) {
  return peer.requests.find((r) => r.method === 'thread/start')?.params as {
    dynamicTools?: Array<{ type: string; name: string; inputSchema: unknown }>
  }
}

describe('CodexRunner: peer tools ride thread/start as dynamic tools', () => {
  it('declares the three tools when a directory is configured, and nothing otherwise', async () => {
    const bare = scriptedPeer()
    scriptTurn(bare, () => {})
    const plain = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: bare.connectFn })
    void plain.start()
    await vi.waitFor(() => expect(threadStart(bare)).toBeDefined())
    expect(threadStart(bare).dynamicTools).toBeUndefined()

    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, peers: directory() })
    void runner.start()
    await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
    const tools = threadStart(peer).dynamicTools!
    expect(tools.map((t) => [t.type, t.name])).toEqual([
      ['function', 'peers_list'],
      ['function', 'peers_peek'],
      ['function', 'peers_send'],
    ])
    expect(tools[2]!.inputSchema).toMatchObject({ type: 'object', required: ['sessionId', 'text'] })
  })

  it('answers item/tool/call from the directory, as the calling session, with the result as input text', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const peers = directory()
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, peers })
    void runner.start()
    await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
    const call = { callId: 'c1', threadId: 'thread-1', turnId: 'turn-1', tool: 'peers_send', arguments: { sessionId: 'b', text: 'ping' } }
    const answer = (await peer.serverRequest('item/tool/call', call)) as {
      success: boolean
      contentItems: Array<{ type: string; text: string }>
    }
    expect(answer.success).toBe(true)
    expect(answer.contentItems).toEqual([{ type: 'inputText', text: expect.stringContaining('Delivered to b') }])
    expect(peers.sent).toEqual([{ from: runner.id, to: 'b', text: 'ping' }])

    const bad = (await peer.serverRequest('item/tool/call', { ...call, arguments: {} })) as { success: boolean }
    expect(bad.success).toBe(false)
  })

  it('refuses item/tool/call when no directory is configured', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    void runner.start()
    await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
    await expect(
      peer.serverRequest('item/tool/call', { callId: 'c', threadId: 't', turnId: 'u', tool: 'peers_list', arguments: {} }),
    ).rejects.toThrow('item/tool/call')
  })

  it('draws a dynamicToolCall item as a tool call that settles with its content', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      const item = { id: 'i1', type: 'dynamicToolCall', tool: 'peers_list', arguments: {}, status: 'inProgress' }
      emit('item/started', { threadId: 'thread-1', turnId, item })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { ...item, status: 'completed', success: true, contentItems: [{ type: 'inputText', text: '[]' }] },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, peers: directory() })
    const events = collect(runner)
    void runner.start()
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(1))
    const calls = ofType(events, 'assistant_message')
      .flatMap((e) => (typeof e.message.content === 'string' ? [] : e.message.content))
      .filter((b) => b.type === 'tool_use')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'peers_list', input: {} })
    const results = ofType(events, 'user_message')
      .flatMap((e) => (typeof e.message.content === 'string' ? [] : e.message.content))
      .filter((b) => b.type === 'tool_result')
    expect(results).toHaveLength(1)
    expect((results[0] as { is_error?: boolean }).is_error).toBeFalsy()
    expect((results[0] as { content?: unknown }).content).toBe('[]')
  })

  it('a peer-origin message is wrapped for the model, bare on the transcript, and never treated as /clear', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('/clear', undefined, { origin: { kind: 'peer', sessionId: 'src-1' } })
    await vi.waitFor(() => expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1))
    const start = peer.requests.find((r) => r.method === 'turn/start')!.params as { input: Array<{ type: string; text?: string }> }
    expect(start.input[0]!.text).toContain('<peer-message from-session="src-1">\n/clear\n</peer-message>')
    expect(peer.requests.some((r) => r.method === 'thread/clear' || r.method === 'thread/rollback')).toBe(false)
    const user = ofType(events, 'user_message').find((e) => !e.synthetic)!
    expect(user).toMatchObject({ message: { content: '/clear' }, origin: { kind: 'peer', sessionId: 'src-1' } })
  })

  it("a person's `#` mention reaches turn/start after their words, and the transcript keeps the bare text", async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('commit what #Astra did', undefined, {
      mentions: [{ typed: 'Astra', id: 'peer-1', name: 'Astra', status: 'idle', cwd: '/work/astra' }],
    })
    await vi.waitFor(() => expect(peer.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1))
    const start = peer.requests.find((r) => r.method === 'turn/start')!.params as { input: Array<{ type: string; text?: string }> }
    expect(start.input[0]!.text).toContain('commit what #Astra did\n\n<peer-mentions>')
    const user = ofType(events, 'user_message').find((e) => !e.synthetic)!
    expect(user).toMatchObject({ message: { content: 'commit what #Astra did' } })
  })
})
