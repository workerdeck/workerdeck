import { describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '@workerdeck/protocol'
import { CodexRunner, SHELL_WRITE_REFUSAL, type PeerDirectory, type ShellDirectory } from '../src/index.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

type ToolAnswer = { success: boolean; contentItems: Array<{ type: string; text: string }> }

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

const RUNNING = {
  ordinal: 1,
  command: 'npm run dev',
  label: 'npm run dev',
  cwd: '/repo',
  owner: 'user' as const,
  status: 'running' as const,
  startedAt: 0,
  bytes: 4,
}

function shellDirectory(): ShellDirectory & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const read = { text: 'ready on 5173', lines: 1, totalLines: 1, truncated: false, view: 'lines' as const }
  return {
    calls,
    list: async () => [],
    read: async (from, shellId) => {
      calls.push(['read', from, shellId])
      return { shell: { id: shellId, ...RUNNING }, ...read }
    },
    run: async (from, options) => {
      calls.push(['run', from, options])
      return { shell: { id: 'sh_new', ...RUNNING, owner: 'agent', command: options.command }, ...read }
    },
    write: async (from, shellId, options) => {
      calls.push(['write', from, shellId, options])
      return { shell: { id: shellId, ...RUNNING, owner: 'agent' }, ...read }
    },
    kill: async (from, shellId) => {
      calls.push(['kill', from, shellId])
      return { shell: { id: shellId, ...RUNNING, owner: 'agent' }, killed: true }
    },
    grant: async (from, shellId) => {
      calls.push(['grant', from, shellId])
      return { id: shellId, ...RUNNING, owner: 'user', agentWrite: true }
    },
  }
}

function threadStart(peer: ReturnType<typeof scriptedPeer>) {
  return peer.requests.find((r) => r.method === 'thread/start')?.params as {
    dynamicTools?: Array<{ type: string; name: string }>
  }
}

async function started(config: { permissionMode?: PermissionMode; shellAgentWrite?: 'gated' | 'allow' }) {
  const peer = scriptedPeer()
  scriptTurn(peer, () => {})
  const shells = shellDirectory()
  const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, shells, ...config })
  const events = collect(runner)
  void runner.start()
  await vi.waitFor(() => expect(threadStart(peer)).toBeDefined())
  const call = (tool: string, args: unknown) =>
    peer.serverRequest('item/tool/call', {
      callId: 'call-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      tool,
      arguments: args,
    }) as Promise<ToolAnswer>
  return { peer, shells, runner, events, call }
}

describe('CodexRunner: shell tools ride the same dynamicTools list', () => {
  it('declares the read tools beside the peer tools, either set alone, and the write tools only when stamped', async () => {
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

    const writing = await started({ shellAgentWrite: 'gated' })
    expect(threadStart(writing.peer).dynamicTools!.map((t) => t.name)).toEqual([
      'shell_list',
      'shell_read',
      'shell_run',
      'shell_write',
      'shell_kill',
      'shell_request_write',
    ])
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
    })) as ToolAnswer
    expect(answer.success).toBe(true)
    expect(answer.contentItems[0]!.text).toContain('ready on 5173')
    expect(shells.calls).toEqual([['read', runner.id, 'sh_a']])
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

describe('CodexRunner: the gateway gates the shell write tools, because codex itself never asks', () => {
  it('refuses a write tool at the tool when the agent is read-only, with no card', async () => {
    const { shells, events, call } = await started({})
    const answer = await call('shell_run', { command: 'npm run dev' })
    expect(answer).toEqual({ success: false, contentItems: [{ type: 'inputText', text: SHELL_WRITE_REFUSAL }] })
    expect(shells.calls).toEqual([])
    expect(ofType(events, 'permission_requested')).toHaveLength(0)
  })

  it('under gated, raises permission_requested with the payload before the call runs, and runs it on allow', async () => {
    const { shells, runner, events, call } = await started({ shellAgentWrite: 'gated' })
    const answer = call('shell_run', { command: 'npm run dev', waitFor: 'ready in' })
    await vi.waitFor(() => expect(ofType(events, 'permission_requested')).toHaveLength(1))
    expect(shells.calls).toEqual([])
    const request = ofType(events, 'permission_requested')[0]!.request
    expect(request).toMatchObject({
      toolName: 'shell_run',
      displayName: 'shell_run',
      title: 'Agent wants to run shell_run',
      input: { command: 'npm run dev', waitFor: 'ready in' },
    })
    expect(request.toolUseId).toMatch(/:call-1$/)
    expect(runner.pendingApprovals.map((r) => r.id)).toEqual([request.id])
    expect(runner.info().pendingPermissionCount).toBe(1)

    expect(runner.resolvePermission(request.id, { behavior: 'allow' })).toBe(true)
    const answered = await answer
    expect(answered.success).toBe(true)
    expect(answered.contentItems[0]!.text).toContain('sh_new')
    expect(shells.calls).toEqual([['run', runner.id, { command: 'npm run dev', waitFor: ['ready in'], timeoutMs: undefined }]])
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({ requestId: request.id, behavior: 'allow', resolvedBy: 'client' })
    expect(runner.pendingApprovals).toHaveLength(0)
  })

  it('runs the edited input when the allow carries one', async () => {
    const { shells, runner, call } = await started({ shellAgentWrite: 'gated' })
    const answer = call('shell_write', { shellId: 'sh_a', keys: ['q'] })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow', updatedInput: { shellId: 'sh_a', keys: ['r'] } })
    expect((await answer).success).toBe(true)
    expect(shells.calls).toEqual([['write', runner.id, 'sh_a', { data: undefined, keys: ['r'], waitFor: undefined, timeoutMs: undefined }]])
  })

  it('answers a deny as a failed tool call that carries the reason, and never touches the directory', async () => {
    const { shells, runner, events, call } = await started({ shellAgentWrite: 'gated' })
    const answer = call('shell_kill', { shellId: 'sh_a' })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny', message: 'leave it running' })
    expect(await answer).toEqual({
      success: false,
      contentItems: [{ type: 'inputText', text: 'the user denied this shell_kill: leave it running' }],
    })
    expect(shells.calls).toEqual([])
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({ behavior: 'deny', resolvedBy: 'client', message: 'leave it running' })

    const silent = call('shell_kill', { shellId: 'sh_a' })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny' })
    expect((await silent).contentItems[0]!.text).toBe('the user denied this shell_kill: Denied')
  })

  it('settles a pending write card on interrupt and on close like every other approval', async () => {
    const interrupted = await started({ shellAgentWrite: 'gated' })
    const first = interrupted.call('shell_run', { command: 'vite' })
    await vi.waitFor(() => expect(interrupted.runner.pendingApprovals).toHaveLength(1))
    // The scripted turn never completes, so the interrupt's own wait on the turn chain is not awaited here.
    void interrupted.runner.interrupt()
    expect(await first).toMatchObject({ success: false, contentItems: [{ text: 'the user denied this shell_run: interrupted' }] })
    expect(interrupted.shells.calls).toEqual([])

    const closed = await started({ shellAgentWrite: 'gated' })
    const second = closed.call('shell_run', { command: 'vite' })
    await vi.waitFor(() => expect(closed.runner.pendingApprovals).toHaveLength(1))
    closed.runner.close()
    expect(await second).toMatchObject({ success: false, contentItems: [{ text: 'the user denied this shell_run: Session closed' }] })
  })

  it('never gates the read tools, and under gated skips the card in bypassPermissions and auto', async () => {
    const gated = await started({ shellAgentWrite: 'gated' })
    expect((await gated.call('shell_read', { shellId: 'sh_a' })).success).toBe(true)
    expect(ofType(gated.events, 'permission_requested')).toHaveLength(0)

    for (const permissionMode of ['bypassPermissions', 'auto'] as const) {
      const { shells, runner, events, call } = await started({ shellAgentWrite: 'gated', permissionMode })
      expect((await call('shell_run', { command: 'vite' })).success).toBe(true)
      expect(shells.calls).toEqual([['run', runner.id, { command: 'vite', waitFor: undefined, timeoutMs: undefined }]])
      expect(ofType(events, 'permission_requested')).toHaveLength(0)
    }

    const edits = await started({ shellAgentWrite: 'gated', permissionMode: 'acceptEdits' })
    void edits.call('shell_run', { command: 'vite' })
    await vi.waitFor(() => expect(edits.runner.pendingApprovals).toHaveLength(1))
  })

  it('under allow, runs the write tools with no card at all', async () => {
    const { shells, runner, events, call } = await started({ shellAgentWrite: 'allow' })
    expect((await call('shell_write', { shellId: 'sh_a', data: 'ls', keys: ['enter'] })).success).toBe(true)
    expect(shells.calls).toEqual([['write', runner.id, 'sh_a', { data: 'ls', keys: ['enter'], waitFor: undefined, timeoutMs: undefined }]])
    expect(ofType(events, 'permission_requested')).toHaveLength(0)
  })

  it('under allow, still cards a grant request, and runs the grant only once it is allowed', async () => {
    const { shells, runner, events, call } = await started({ shellAgentWrite: 'allow' })
    const answer = call('shell_request_write', { shellId: 'sh_a', reason: 'answer the prompt' })
    await vi.waitFor(() => expect(ofType(events, 'permission_requested')).toHaveLength(1))
    expect(shells.calls).toEqual([])
    expect(ofType(events, 'permission_requested')[0]!.request).toMatchObject({
      toolName: 'shell_request_write',
      input: { shellId: 'sh_a', reason: 'answer the prompt' },
    })
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    const answered = await answer
    expect(answered.success).toBe(true)
    expect(answered.contentItems[0]!.text).toContain('granted')
    expect(shells.calls).toEqual([['grant', runner.id, 'sh_a']])
  })
})
