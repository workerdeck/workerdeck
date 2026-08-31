import { describe, expect, it, vi } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import type { Runner } from '../src/runner-interface.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner: skills and MCP servers', () => {
  it('lists skills over skills/list, and re-lists when the watcher says they changed', async () => {
    const peer = scriptedPeer()
    let listCalls = 0
    peer.respond('skills/list', () => {
      listCalls += 1
      return {
        data: [
          {
            cwd: '/tmp',
            skills: [
              {
                name: 'imagegen',
                description: 'Generate images from a prompt',
                scope: 'user',
                enabled: true,
                interface: {
                  displayName: 'Image generation',
                  shortDescription: 'Make a picture',
                  defaultPrompt: 'Generate an image of',
                },
              },
              { name: 'imagegen', description: 'duplicate', scope: 'repo' },
              ...(listCalls > 1 ? [{ name: 'pdf-fill', description: 'Fill PDF forms', enabled: false }] : []),
            ],
            errors: [],
          },
        ],
      }
    })
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()

    expect(peer.requests.find((r) => r.method === 'skills/list')?.params).toEqual({
      cwds: ['/tmp/project'],
    })

    const first = ofType(events, 'skills')
    expect(first).toHaveLength(1)
    expect(first[0]!.skills).toEqual([
      {
        name: 'imagegen',
        description: 'Generate images from a prompt',
        shortDescription: 'Make a picture',
        displayName: 'Image generation',
        defaultPrompt: 'Generate an image of',
        scope: 'user',
        enabled: true,
      },
    ])

    peer.emit('skills/changed', {})
    await vi.waitFor(() => expect(ofType(events, 'skills')).toHaveLength(2))
    const second = ofType(events, 'skills')[1]!
    expect(second.skills.map((s) => s.name)).toEqual(['imagegen', 'pdf-fill'])
    expect(second.skills[1]).toMatchObject({ name: 'pdf-fill', enabled: false })

    peer.emit('skills/changed', {})
    peer.emit('skills/changed', {})
    await vi.waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(3))
    expect(ofType(events, 'skills')).toHaveLength(2)
  })

  it('lists skills before the first turn, over a connection it then throws away', async () => {
    const peer = scriptedPeer()
    peer.respond('skills/list', () => ({
      data: [{ cwd: '/tmp/project', skills: [{ name: 'scratch-notes', enabled: true }] }],
    }))

    const runner = new CodexRunner({ cwd: '/tmp/project', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()

    await vi.waitFor(() => expect(ofType(events, 'skills')).toHaveLength(1))
    expect(ofType(events, 'skills')[0]!.skills.map((s) => s.name)).toEqual(['scratch-notes'])
    expect(peer.requests.some((r) => r.method === 'thread/start')).toBe(false)
    await vi.waitFor(() => expect(peer.closed()).toBe(1))
    expect(runner.status).toBe('idle')
  })

  it('does not probe when the session is about to connect anyway', async () => {
    const peer = scriptedPeer()
    peer.respond('skills/list', () => ({ data: [] }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({ cwd: '/tmp/p', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()

    expect(peer.connections()).toBe(1)
  })

  it('merges mcpServerStatus/list with the startup notifications that carry liveness', async () => {
    const peer = scriptedPeer()
    peer.respond('mcpServerStatus/list', () => ({
      data: [
        {
          name: 'scratch',
          serverInfo: { name: 'scratch-mcp', version: '0.1.0', title: null },
          authStatus: 'unsupported',
          tools: {
            scratch_ping: {
              name: 'scratch_ping',
              description: 'Prove the server is reachable',
              inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
              annotations: { readOnlyHint: true, destructiveHint: null },
            },
          },
        },
        { name: 'broken', authStatus: 'unsupported', tools: {} },
        { name: 'needs-login', authStatus: 'notLoggedIn', tools: {} },
        { name: 'never-reported', authStatus: 'unsupported', tools: {} },
        {
          name: 'silently-fine',
          authStatus: 'unsupported',
          tools: { do_thing: { name: 'do_thing' } },
        },
      ],
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({ cwd: '/tmp/p', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()

    peer.emit('mcpServer/startupStatus/updated', { name: 'scratch', status: 'ready' })
    peer.emit('mcpServer/startupStatus/updated', {
      name: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    })

    const servers = await runner.mcpServers()
    expect(servers?.map((s) => `${s.name}:${s.status}`)).toEqual([
      'scratch:connected',
      'broken:failed',
      'needs-login:needs-auth',
      'never-reported:pending',
      'silently-fine:connected',
    ])
    expect(servers?.find((s) => s.name === 'broken')?.error).toBe('spawn ENOENT')
    expect(servers?.[0]).toMatchObject({
      serverInfo: { name: 'scratch-mcp', version: '0.1.0' },
      tools: [
        {
          name: 'scratch_ping',
          description: 'Prove the server is reachable',
          inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
          annotations: { readOnly: true },
        },
      ],
    })

    const asRunner: Runner = runner
    expect(asRunner.reconnectMcpServer).toBeUndefined()
    expect(asRunner.setMcpServerEnabled).toBeUndefined()
  })

  it('answers MCP status before the session has connected, over a throwaway child', async () => {
    const peer = scriptedPeer()
    peer.respond('mcpServerStatus/list', () => ({
      data: [{ name: 'scratch', authStatus: 'unsupported', tools: { ping: { name: 'ping' } } }],
    }))
    const runner = new CodexRunner({ cwd: '/tmp/p', connectFn: peer.connectFn })

    const servers = await runner.mcpServers()
    expect(servers?.map((s) => `${s.name}:${s.status}`)).toEqual(['scratch:connected'])
    expect(peer.requests.some((r) => r.method === 'thread/start')).toBe(false)
    expect(peer.closed()).toBe(1)
  })

  it('reports no MCP servers once the session is closed', async () => {
    const peer = scriptedPeer()
    const runner = new CodexRunner({ cwd: '/tmp/p', connectFn: peer.connectFn })
    runner.close()
    expect(await runner.mcpServers()).toBeUndefined()
  })

  it('says nothing about skills when the binary rejects skills/list', async () => {
    const peer = scriptedPeer()
    peer.respond('skills/list', () => {
      throw new Error('method not found')
    })
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    expect(ofType(events, 'skills')).toHaveLength(0)
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(runner.status).toBe('idle')
  })
})
