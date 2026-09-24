import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner, type PeerDirectory, type ShellDirectory } from '../src/index.ts'
import { fakeHarness } from './helpers/claude-harness.ts'

function peerDirectory(): PeerDirectory {
  return {
    list: async () => [],
    peek: async () => undefined,
    send: async (_from, to) => ({ delivered: true, sessionId: to, queued: false }),
  }
}

const EXITED = {
  ordinal: 2,
  command: 'npm test',
  label: 'npm test',
  cwd: '/repo',
  owner: 'user' as const,
  status: 'exited' as const,
  startedAt: 0,
  endedAt: 1,
  exitCode: 1,
  endReason: 'exit' as const,
  bytes: 9,
}

function shellDirectory(): ShellDirectory & { calls: unknown[][] } {
  const calls: unknown[][] = []
  const read = { text: 'FAIL auth.ts', lines: 1, totalLines: 1, truncated: false, view: 'lines' as const }
  return {
    calls,
    list: async () => [],
    read: async (from, shellId) => {
      calls.push(['read', from, shellId])
      return { shell: { id: shellId, ...EXITED }, ...read }
    },
    run: async (from, options) => {
      calls.push(['run', from, options])
      return { shell: { id: 'sh_new', ...EXITED, owner: 'agent', command: options.command }, ...read }
    },
    write: async (from, shellId, options) => {
      calls.push(['write', from, shellId, options])
      return { shell: { id: shellId, ...EXITED, owner: 'agent' }, ...read }
    },
    kill: async (from, shellId) => {
      calls.push(['kill', from, shellId])
      return { shell: { id: shellId, ...EXITED, owner: 'agent' }, killed: true }
    },
    grant: async (from, shellId) => {
      calls.push(['grant', from, shellId])
      return { id: shellId, ...EXITED, owner: 'user', agentWrite: true }
    },
  }
}

function registered(harness: ReturnType<typeof fakeHarness>) {
  const server = (harness.captured.options!.mcpServers as Record<string, { instance: unknown }>).workerdeck
  const instance = server.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>
  return instance['_registeredTools'] ?? {}
}

function canUseTool(harness: ReturnType<typeof fakeHarness>, toolName: string, input: Record<string, unknown>) {
  return harness.captured.options!.canUseTool!(toolName, input, {
    signal: new AbortController().signal,
    requestId: 'creq-1',
    toolUseID: 'tool-1',
  })
}

describe('SessionRunner: shell tools', () => {
  it('rides the one workerdeck MCP server, alone or beside the peer tools', async () => {
    const alone = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/p', queryFn: alone.queryFn, shells: shellDirectory() }).start()
    await vi.waitFor(() => expect(alone.captured.options).toBeDefined())
    expect(Object.keys(registered(alone)).sort()).toEqual(['shell_list', 'shell_read'])

    const both = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/p', queryFn: both.queryFn, peers: peerDirectory(), shells: shellDirectory() }).start()
    await vi.waitFor(() => expect(both.captured.options).toBeDefined())
    expect(Object.keys(registered(both)).sort()).toEqual(['peers_list', 'peers_peek', 'peers_send', 'shell_list', 'shell_read'])
  })

  it('declares no server at all when neither directory is configured', async () => {
    const harness = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn }).start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(harness.captured.options?.mcpServers).toBeUndefined()
  })

  it('calls the directory with this runner as the reader', async () => {
    const harness = fakeHarness()
    const shells = shellDirectory()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells })
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const result = await registered(harness).shell_read!.handler({ shellId: 'sh_b' }, {})
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('FAIL auth.ts') }] })
    expect(shells.calls).toEqual([['read', runner.id, 'sh_b']])
  })

  it('registers the write tools only when the gateway stamped shellAgentWrite, and runs them as this runner', async () => {
    const harness = fakeHarness()
    const shells = shellDirectory()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells, shellAgentWrite: 'gated' })
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    expect(Object.keys(registered(harness)).sort()).toEqual([
      'shell_kill',
      'shell_list',
      'shell_read',
      'shell_request_write',
      'shell_run',
      'shell_write',
    ])
    const started = await registered(harness).shell_run!.handler({ command: 'npm run dev' }, {})
    expect(started).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('sh_new') }] })
    await registered(harness).shell_write!.handler({ shellId: 'sh_new', keys: ['r'] }, {})
    await registered(harness).shell_kill!.handler({ shellId: 'sh_new' }, {})
    expect(shells.calls).toEqual([
      ['run', runner.id, { command: 'npm run dev', waitFor: undefined, timeoutMs: undefined }],
      ['write', runner.id, 'sh_new', { data: undefined, keys: ['r'], waitFor: undefined, timeoutMs: undefined }],
      ['kill', runner.id, 'sh_new'],
    ])
  })

  it('under gated, leaves the permission path to Claude Code: a write tool prompt is a pending approval', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells: shellDirectory(), shellAgentWrite: 'gated' })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const pending = canUseTool(harness, 'mcp__workerdeck__shell_run', { command: 'npm run dev' })
    expect(runner.pendingApprovals).toHaveLength(1)
    expect(runner.pendingApprovals[0]).toMatchObject({ toolName: 'mcp__workerdeck__shell_run', input: { command: 'npm run dev' } })
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny', message: 'not now' })
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: 'not now' })
    expect(events.filter((e) => e.type === 'permission_resolved')).toHaveLength(1)
  })

  it('under allow, resolves a write tool prompt by policy and still records the card, and leaves every other tool alone', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells: shellDirectory(), shellAgentWrite: 'allow' })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    await expect(canUseTool(harness, 'mcp__workerdeck__shell_write', { shellId: 'sh_a', keys: ['r'] })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { shellId: 'sh_a', keys: ['r'] },
      toolUseID: 'tool-1',
    })
    expect(runner.pendingApprovals).toHaveLength(0)
    const requested = events.filter((e) => e.type === 'permission_requested')
    expect(requested).toHaveLength(1)
    expect(requested[0]).toMatchObject({ request: { toolName: 'mcp__workerdeck__shell_write', input: { shellId: 'sh_a', keys: ['r'] } } })
    expect(events.filter((e) => e.type === 'permission_resolved')[0]).toMatchObject({ behavior: 'allow', resolvedBy: 'policy' })

    void canUseTool(harness, 'Bash', { command: 'rm -rf /' })
    expect(runner.pendingApprovals).toHaveLength(1)
    void canUseTool(harness, 'mcp__workerdeck__shell_request_write', { shellId: 'sh_a', reason: 'answer the prompt' })
    expect(runner.pendingApprovals).toHaveLength(2)
    expect(runner.pendingApprovals[1]).toMatchObject({ toolName: 'mcp__workerdeck__shell_request_write' })
  })

  it('never cards the read tools, whatever the write mode, and still records them as resolved by policy', async () => {
    for (const shellAgentWrite of [undefined, 'gated', 'allow'] as const) {
      const harness = fakeHarness()
      const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells: shellDirectory(), shellAgentWrite })
      const events: SessionEvent[] = []
      runner.subscribe((e) => events.push(e))
      void runner.start()
      await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
      await expect(canUseTool(harness, 'mcp__workerdeck__shell_read', { shellId: 'sh_a' })).resolves.toMatchObject({ behavior: 'allow' })
      await expect(canUseTool(harness, 'mcp__workerdeck__shell_list', {})).resolves.toMatchObject({ behavior: 'allow' })
      expect(runner.pendingApprovals).toHaveLength(0)
      expect(events.filter((e) => e.type === 'permission_resolved')).toHaveLength(2)
    }
    const bare = fakeHarness()
    const unstamped = new SessionRunner({ cwd: '/tmp/p', queryFn: bare.queryFn })
    void unstamped.start()
    await vi.waitFor(() => expect(bare.captured.options).toBeDefined())
    void canUseTool(bare, 'mcp__workerdeck__shell_read', { shellId: 'sh_a' })
    expect(unstamped.pendingApprovals).toHaveLength(1)
  })

  it('cards a grant request under gated too, and the allowed request runs the grant as this runner', async () => {
    const harness = fakeHarness()
    const shells = shellDirectory()
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn, shells, shellAgentWrite: 'gated' })
    void runner.start()
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    void canUseTool(harness, 'mcp__workerdeck__shell_request_write', { shellId: 'sh_a', reason: 'answer the prompt' })
    expect(runner.pendingApprovals).toHaveLength(1)
    const granted = await registered(harness).shell_request_write!.handler({ shellId: 'sh_a', reason: 'answer the prompt' }, {})
    expect(granted).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('granted') }] })
    expect(shells.calls).toContainEqual(['grant', runner.id, 'sh_a'])
  })
})
