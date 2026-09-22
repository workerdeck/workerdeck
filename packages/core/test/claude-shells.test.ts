import { describe, expect, it, vi } from 'vitest'
import { SessionRunner, type PeerDirectory, type ShellDirectory } from '../src/index.ts'
import { fakeHarness } from './helpers/claude-harness.ts'

function peerDirectory(): PeerDirectory {
  return {
    list: async () => [],
    peek: async () => undefined,
    send: async (_from, to) => ({ delivered: true, sessionId: to, queued: false }),
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
          ordinal: 2,
          command: 'npm test',
          label: 'npm test',
          cwd: '/repo',
          owner: 'user',
          status: 'exited',
          startedAt: 0,
          endedAt: 1,
          exitCode: 1,
          endReason: 'exit',
          bytes: 9,
        },
        text: 'FAIL auth.ts',
        lines: 1,
        totalLines: 1,
        truncated: false,
      }
    },
  }
}

function registered(harness: ReturnType<typeof fakeHarness>) {
  const server = (harness.captured.options!.mcpServers as Record<string, { instance: unknown }>).workerdeck
  const instance = server.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>
  return instance['_registeredTools'] ?? {}
}

describe('SessionRunner: shell read tools', () => {
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
    expect(shells.reads).toEqual([{ from: runner.id, shellId: 'sh_b' }])
  })
})
