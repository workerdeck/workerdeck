import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import {
  installPeerDirectory,
  peerDirectoryHandle,
  peerMessageEnvelope,
  peerToolSpecs,
  recentLines,
  runPeerTool,
  type PeerDirectory,
} from '../src/index.ts'

function directory(overrides: Partial<PeerDirectory> = {}): PeerDirectory & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return {
    calls,
    list: async (...args) => {
      calls.push(['list', ...args])
      return [{ id: 'b', status: 'idle', cwd: '/b', pendingPermissionCount: 0, engine: 'codex' }]
    },
    peek: async (...args) => {
      calls.push(['peek', ...args])
      return { id: 'b', status: 'idle', cwd: '/b', pendingPermissionCount: 0, live: true, pendingApprovals: [], recent: ['assistant: hi'] }
    },
    send: async (...args) => {
      calls.push(['send', ...args])
      return { delivered: true, sessionId: 'b', queued: false }
    },
    ...overrides,
  }
}

function event(body: SessionEventBody, seq: number): SessionEvent {
  return { ...body, seq, ts: seq } as SessionEvent
}

describe('peer tool specs', () => {
  it('describes the three tools with JSON schemas an engine can declare', () => {
    const specs = peerToolSpecs()
    expect(specs.map((s) => s.name)).toEqual(['peers_list', 'peers_peek', 'peers_send'])
    const send = specs.find((s) => s.name === 'peers_send')!
    expect(send.inputSchema).toMatchObject({ type: 'object', required: ['sessionId', 'text'] })
    expect((send.inputSchema.properties as Record<string, unknown>).text).toMatchObject({ type: 'string' })
  })
})

describe('runPeerTool', () => {
  it('routes each tool to the directory with the caller first', async () => {
    const dir = directory()
    await runPeerTool(dir, 'a', 'peers_list', {})
    await runPeerTool(dir, 'a', 'peers_peek', { sessionId: 'b', recent: 3 })
    await runPeerTool(dir, 'a', 'peers_send', { sessionId: 'b', text: 'hello' })
    expect(dir.calls).toEqual([
      ['list', 'a'],
      ['peek', 'a', 'b', { recent: 3 }],
      ['send', 'a', 'b', 'hello'],
    ])
  })

  it('rejects malformed arguments and unknown tools as errors, never throws', async () => {
    const dir = directory()
    expect(await runPeerTool(dir, 'a', 'peers_send', { sessionId: 'b' })).toMatchObject({
      isError: true,
      text: expect.stringContaining('text'),
    })
    expect(await runPeerTool(dir, 'a', 'peers_send', { sessionId: 'b', text: '' })).toMatchObject({ isError: true })
    expect(await runPeerTool(dir, 'a', 'nope', {})).toMatchObject({ isError: true, text: 'unknown peer tool: nope' })
    expect(dir.calls).toEqual([])
  })

  it('reports a refused delivery as an error with the reason, and a directory failure as its message', async () => {
    const refused = directory({ send: async () => ({ delivered: false, reason: 'rate limit' }) })
    expect(await runPeerTool(refused, 'a', 'peers_send', { sessionId: 'b', text: 'x' })).toEqual({
      isError: true,
      text: 'not delivered: rate limit',
    })
    const broken = directory({
      list: async () => {
        throw new Error('registry gone')
      },
    })
    expect(await runPeerTool(broken, 'a', 'peers_list', {})).toEqual({ isError: true, text: 'registry gone' })
  })

  it('tells the sender whether the peer was mid-turn, and never to wait', async () => {
    const queued = directory({ send: async () => ({ delivered: true, sessionId: 'b', queued: true }) })
    const output = await runPeerTool(queued, 'a', 'peers_send', { sessionId: 'b', text: 'x' })
    expect(output.isError).toBe(false)
    expect(output.text).toContain('mid-turn')
    expect(output.text).toContain('Do not wait')
  })
})

describe('peerMessageEnvelope', () => {
  it('wraps the text with the sender and the framing, with attribute characters stripped from the name', () => {
    const text = peerMessageEnvelope('please review', { kind: 'peer', sessionId: 'abc', name: 'Fix "auth" <x>', engine: 'claude' })
    expect(
      text.startsWith('<peer-message from-session="abc" from-name="Fix auth x" from-engine="claude">\nplease review\n</peer-message>'),
    ).toBe(true)
    expect(text).toContain('not from your user')
    expect(text).toContain('peers_send to session abc')
  })
})

describe('recentLines', () => {
  it('keeps the newest prose and prompts, top-level only, newest last', () => {
    const events: SessionEvent[] = [
      event({ type: 'user_message', message: { role: 'user', content: 'do the thing' }, parentToolUseId: null }, 1),
      event(
        {
          type: 'assistant_message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] },
          parentToolUseId: null,
          uuid: 'a',
        },
        2,
      ),
      event(
        {
          type: 'assistant_message',
          message: { role: 'assistant', content: [{ type: 'text', text: 'nested' }] },
          parentToolUseId: 'tool-1',
          uuid: 'b',
        },
        3,
      ),
      event({ type: 'user_message', message: { role: 'user', content: 'ctx' }, parentToolUseId: null, synthetic: true }, 4),
      event(
        {
          type: 'user_message',
          message: { role: 'user', content: 'ping' },
          parentToolUseId: null,
          origin: { kind: 'peer', sessionId: 'zzz' },
        },
        5,
      ),
      event({ type: 'session_error', message: 'boom' }, 6),
    ]
    expect(recentLines(events, 10)).toEqual(['user: do the thing', 'assistant: on it', 'peer zzz: ping', 'error: boom'])
    expect(recentLines(events, 2)).toEqual(['peer zzz: ping', 'error: boom'])
  })
})

describe('peerDirectoryHandle', () => {
  it('resolves the installed directory per call, so a swap is seen by an existing handle', async () => {
    const handle = peerDirectoryHandle()
    installPeerDirectory(undefined)
    await expect(handle.list('a')).rejects.toThrow('not available')
    const first = directory()
    installPeerDirectory(first)
    await handle.list('a')
    const second = directory()
    installPeerDirectory(second)
    await handle.list('a')
    expect(first.calls).toHaveLength(1)
    expect(second.calls).toHaveLength(1)
    installPeerDirectory(undefined)
  })
})
