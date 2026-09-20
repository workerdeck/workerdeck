import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner, type PeerDirectory } from '../src/index.ts'
import { fakeHarness } from './helpers/claude-harness.ts'

function directory(): PeerDirectory & { sent: Array<{ from: string; to: string; text: string }> } {
  const sent: Array<{ from: string; to: string; text: string }> = []
  return {
    sent,
    list: async () => [],
    peek: async () => undefined,
    send: async (from, to, text) => {
      sent.push({ from, to, text })
      return { delivered: true, sessionId: to, queued: false }
    },
  }
}

describe('SessionRunner: peer tools', () => {
  it('declares an in-process MCP server named workerdeck only when a directory is configured', async () => {
    const without = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/p', queryFn: without.queryFn }).start()
    await vi.waitFor(() => expect(without.captured.options).toBeDefined())
    expect(without.captured.options?.mcpServers).toBeUndefined()

    const harness = fakeHarness()
    const runner = new SessionRunner({
      cwd: '/tmp/p',
      queryFn: harness.queryFn,
      peers: directory(),
      mcpServers: { other: { type: 'http', url: 'http://x' } },
    })
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const servers = harness.captured.options?.mcpServers as Record<string, { type?: string; name?: string }>
    expect(Object.keys(servers)).toEqual(['other', 'workerdeck'])
    expect(servers.workerdeck).toMatchObject({ type: 'sdk', name: 'workerdeck' })
  })

  it('the server tools call the directory with this runner as the sender', async () => {
    const harness = fakeHarness()
    const peers = directory()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, peers })
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const server = (harness.captured.options!.mcpServers as Record<string, { instance: unknown }>).workerdeck
    const instance = server.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>
    const tools = instance['_registeredTools'] ?? {}
    expect(Object.keys(tools).sort()).toEqual(['peers_list', 'peers_peek', 'peers_send'])
    const result = await tools.peers_send!.handler({ sessionId: 'b', text: 'hi' }, {})
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('Delivered to b') }] })
    expect(peers.sent).toEqual([{ from: runner.id, to: 'b', text: 'hi' }])
  })

  it('a message with a peer origin reaches the model wrapped and the transcript bare, stamped with the origin', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    runner.sendMessage('please look at auth.ts', undefined, {
      origin: { kind: 'peer', sessionId: 'src-1', name: 'Auth fix', engine: 'codex' },
    })
    await vi.waitFor(() => expect(harness.captured.inputs).toHaveLength(1))
    const content = harness.captured.inputs[0]!.message.content as string
    expect(content).toContain('<peer-message from-session="src-1" from-name="Auth fix" from-engine="codex">')
    expect(content).toContain('please look at auth.ts')
    const user = events.find((event) => event.type === 'user_message')!
    expect(user).toMatchObject({
      type: 'user_message',
      message: { role: 'user', content: 'please look at auth.ts' },
      origin: { kind: 'peer', sessionId: 'src-1', name: 'Auth fix', engine: 'codex' },
    })
    expect((user as { synthetic?: boolean }).synthetic).toBeUndefined()
  })
})
