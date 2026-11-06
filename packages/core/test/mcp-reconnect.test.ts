import { describe, expect, it } from 'vitest'
import type { McpServerStatusInfo } from '@workerdeck/protocol'
import { SessionRunner } from '../src/index.ts'
import { runSessionTool, sessionToolSpecs } from '../src/lib/session-tools.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { eventually } from './helpers/wait.ts'

function control(servers: McpServerStatusInfo[], refuse: string[] = []) {
  const reconnected: string[] = []
  return {
    reconnected,
    sources: {
      write: false,
      mcp: {
        list: async () => servers.map((server) => ({ ...server })),
        reconnect: async (name: string) => {
          reconnected.push(name)
          if (refuse.includes(name)) {
            throw new Error('connection refused')
          }
          const server = servers.find((candidate) => candidate.name === name)!
          server.status = 'connected'
          delete server.error
        },
      },
    },
  }
}

describe('mcp_reconnect', () => {
  it('is offered only with an MCP control', () => {
    expect(sessionToolSpecs(control([]).sources).map((spec) => spec.name)).toEqual(['mcp_reconnect'])
    expect(sessionToolSpecs({ write: false }).map((spec) => spec.name)).toEqual([])
  })

  it('reconnects every failed server and leaves needs-auth and disabled ones alone', async () => {
    const rig = control([
      { name: 'shuttle', status: 'failed', error: 'ECONNREFUSED' },
      { name: 'linear', status: 'needs-auth' },
      { name: 'off', status: 'disabled' },
      { name: 'ok', status: 'connected' },
    ])
    const out = await runSessionTool(rig.sources, 's', 'mcp_reconnect', {})
    expect(rig.reconnected).toEqual(['shuttle'])
    expect(out).toEqual({ text: expect.stringMatching(/^Reconnected shuttle\.\n- shuttle: connected\n/), isError: false })
  })

  it('reconnects a named server whatever its state, and refuses an unknown name', async () => {
    const rig = control([{ name: 'ok', status: 'connected' }])
    expect((await runSessionTool(rig.sources, 's', 'mcp_reconnect', { server: 'ok' }))?.isError).toBe(false)
    expect(rig.reconnected).toEqual(['ok'])
    const unknown = await runSessionTool(rig.sources, 's', 'mcp_reconnect', { server: 'nope' })
    expect(unknown).toEqual({ text: expect.stringContaining('No MCP server named "nope"'), isError: true })
  })

  it('reports a failed reconnect with the error and the states after', async () => {
    const rig = control([{ name: 'shuttle', status: 'failed' }], ['shuttle'])
    const out = await runSessionTool(rig.sources, 's', 'mcp_reconnect', {})
    expect(out).toEqual({ text: 'Reconnect failed for shuttle (connection refused).\n- shuttle: failed', isError: true })
  })
})

describe('SessionRunner: MCP self-heal on send', () => {
  const start = (servers: Array<{ name: string; status: string }>) => {
    const harness = fakeHarness({ mcpServers: servers })
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn })
    void runner.start()
    return { harness, runner }
  }

  it('reconnects failed servers when a message goes to a running engine, once a minute at most', async () => {
    const servers = [
      { name: 'shuttle', status: 'failed' },
      { name: 'ok', status: 'connected' },
    ]
    const { harness, runner } = start(servers)
    await eventually(() => expect(harness.captured.options).toBeDefined())
    runner.sendMessage('hello')
    await eventually(() => expect(harness.reconnectMcpServer).toHaveBeenCalledWith('shuttle'))
    expect(harness.reconnectMcpServer).toHaveBeenCalledTimes(1)
    servers[0]!.status = 'failed'
    runner.sendMessage('again')
    await tick()
    expect(harness.reconnectMcpServer).toHaveBeenCalledTimes(1)
  })

  it('leaves a slash command alone', async () => {
    const { harness, runner } = start([{ name: 'shuttle', status: 'failed' }])
    await eventually(() => expect(harness.captured.options).toBeDefined())
    runner.sendMessage('/compact')
    await tick()
    expect(harness.reconnectMcpServer).not.toHaveBeenCalled()
  })

  it('offers the tool against the live engine', async () => {
    const { harness } = start([{ name: 'shuttle', status: 'failed' }])
    await eventually(() => expect(harness.captured.options).toBeDefined())
    const server = (harness.captured.options!.mcpServers as Record<string, { instance: unknown }>).workerdeck
    const instance = server.instance as Record<string, Record<string, { handler: (args: unknown, extra: unknown) => Promise<unknown> }>>
    const result = await instance['_registeredTools']!.mcp_reconnect!.handler({}, {})
    expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: 'Reconnected shuttle.\n- shuttle: connected' }] })
  })
})
