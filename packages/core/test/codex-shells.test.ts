import { describe, expect, it, vi } from 'vitest'
import { CodexRunner, type PeerDirectory, type ShellDirectory } from '../src/index.ts'
import { scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

function peerDirectory(): PeerDirectory & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    list: async () => {
      calls.push('list')
      return []
    },
    peek: async () => {
      calls.push('peek')
      return undefined
    },
    send: async (_from, to) => {
      calls.push('send')
      return { delivered: true, sessionId: to, queued: false }
    },
  }
}

function shellDirectory(): ShellDirectory & { reads: Array<{ from: string; shellId: string }> } {
  const reads: Array<{ from: string; shellId: string }> = []
  return {
    reads,
    list: async () => [],
    read: async (from, shellId) => {
      reads.push({ from, shellId })
      return {
        shell: {
          id: shellId,
          ordinal: 1,
          command: 'npm run dev',
          label: 'npm run dev',
          cwd: '/repo',
          owner: 'user',
          status: 'running',
          startedAt: 0,
          bytes: 4,
        },
        text: 'ready on 5173',
        lines: 1,
        totalLines: 1,
        truncated: false,
      }
    },
  }
}

function threadStart(peer: ReturnType<typeof scriptedPeer>) {
  return peer.requests.find((r) => r.method === 'thread/start')?.params as {
    dynamicTools?: Array<{ type: string; name: string }>
  }
}

describe('CodexRunner: shell read tools ride the same dynamicTools list', () => {
  it('declares the shell tools beside the peer tools, and either set alone', async () => {
    const both = scriptedPeer()
    scriptTurn(both, () => {})
    void new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: both.connectFn, peers: peerDirectory(), shells: shellDirectory() }).start()
    await vi.waitFor(() => expect(threadStart(both)).toBeDefined())
    expect(threadStart(both).dynamicTools!.map((t) => t.name)).toEqual([
      'peers_list',
      'peers_peek',
      'peers_send',
      'shell_list',
      'shell_read',
    ])

    const alone = scriptedPeer()
    scriptTurn(alone, () => {})
    void new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: alone.connectFn, shells: shellDirectory() }).start()
    await vi.waitFor(() => expect(threadStart(alone)).toBeDefined())
    expect(threadStart(alone).dynamicTools!.map((t) => t.name)).toEqual(['shell_list', 'shell_read'])
  })

  it('dispatches item/tool/call by name, so a shell call never reaches the peer directory', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const peers = peerDirectory()
    const shells = shellDirectory()
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, peers, shells })
    void runner.start()
    await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
    const answer = (await peer.serverRequest('item/tool/call', {
      callId: 'c1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tool: 'shell_read',
      arguments: { shellId: 'sh_a' },
    })) as { success: boolean; contentItems: Array<{ type: string; text: string }> }
    expect(answer.success).toBe(true)
    expect(answer.contentItems[0]!.text).toContain('ready on 5173')
    expect(shells.reads).toEqual([{ from: runner.id, shellId: 'sh_a' }])
    expect(peers.calls).toEqual([])
  })

  it('refuses a dynamic tool call it does not implement, and any call when no directory is configured', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, shells: shellDirectory() })
    void runner.start()
    await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
    await expect(
      peer.serverRequest('item/tool/call', { callId: 'c', threadId: 't', turnId: 'u', tool: 'peers_list', arguments: {} }),
    ).rejects.toThrow('item/tool/call')

    const bare = scriptedPeer()
    scriptTurn(bare, () => {})
    void new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: bare.connectFn }).start()
    await vi.waitFor(() => expect(threadStart(bare)).toBeDefined())
    expect(threadStart(bare).dynamicTools).toBeUndefined()
    await expect(
      bare.serverRequest('item/tool/call', { callId: 'c', threadId: 't', turnId: 'u', tool: 'shell_read', arguments: { shellId: 'x' } }),
    ).rejects.toThrow('item/tool/call')
  })
})
