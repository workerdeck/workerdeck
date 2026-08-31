import { describe, expect, it } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { GRANULAR_ASK, USAGE_A, USAGE_B, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner: turns, streaming and item mapping', () => {
  it("ignores a sub-agent thread's turn lifecycle and usage, but keeps its work", async () => {
    const on = scriptedPeer()
    scriptTurn(on, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'call_spawn',
          type: 'subAgentActivity',
          kind: 'started',
          agentThreadId: 'thread-child',
          agentPath: '/root/luna_1',
        },
      })
      emit('turn/started', { threadId: 'thread-child', turn: { id: 'turn-child', status: 'inProgress' } })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-child',
        turnId: 'turn-child',
        tokenUsage: { last: USAGE_B, total: USAGE_B, modelContextWindow: 1_000 },
      })
      emit('item/completed', {
        threadId: 'thread-child',
        turnId: 'turn-child',
        item: { id: 'item_child', type: 'agentMessage', text: 'child says hi' },
      })
      emit('turn/completed', { threadId: 'thread-child', turn: { id: 'turn-child', status: 'completed' } })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_root', type: 'agentMessage', text: 'the real answer' },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A, modelContextWindow: 1_000 },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: on.connectFn })
    const events = collect(runner)
    await runner.start()

    const results = ofType(events, 'turn_result')
    expect(results).toHaveLength(1)
    expect(results[0]!.result).toBe('the real answer')
    const texts = ofType(events, 'assistant_message')
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
    expect(texts).toEqual(['child says hi', 'the real answer'])
    expect(results[0]!.usage).toMatchObject({
      input_tokens: USAGE_A.inputTokens - USAGE_A.cachedInputTokens,
    })
    const context = ofType(events, 'context_usage').at(-1)
    expect(context?.usage.totalTokens).toBe(USAGE_A.totalTokens)
  })

  it('streams token deltas — text and reasoning with section breaks — suppressibly', async () => {
    const script = (emit: (m: string, p: unknown) => void, turnId: string) => {
      const base = { threadId: 'thread-1', turnId, itemId: 'item_0' }
      emit('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 0, delta: 'First' })
      emit('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 0, delta: ' part' })
      emit('item/reasoning/summaryTextDelta', { ...base, summaryIndex: 1, delta: 'Second' })
      emit('item/agentMessage/delta', { ...base, itemId: 'item_1', delta: 'He' })
      emit('item/agentMessage/delta', { ...base, itemId: 'item_1', delta: 'llo' })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_1', type: 'agentMessage', text: 'Hello' },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    }

    const on = scriptedPeer()
    scriptTurn(on, script)
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: on.connectFn })
    const events = collect(runner)
    await runner.start()
    const deltas = ofType(events, 'stream_delta').map((e) => e.event.delta as { text?: string; thinking?: string })
    expect(deltas.map((d) => d.thinking ?? d.text)).toEqual([
      'First',
      ' part',
      '\n\nSecond', // the summaryIndex bump renders as a paragraph break
      'He',
      'llo',
    ])
    const texts = ofType(events, 'assistant_message').filter(
      (e) => Array.isArray(e.message.content) && e.message.content[0]!.type === 'text',
    )
    expect((texts[0]!.message.content as Array<{ text: string }>)[0]!.text).toBe('Hello')

    const off = scriptedPeer()
    scriptTurn(off, script)
    const quiet = new CodexRunner({
      cwd: '/tmp',
      prompt: 'hi',
      includePartialMessages: false,
      connectFn: off.connectFn,
    })
    const quietEvents = collect(quiet)
    await quiet.start()
    expect(quietEvents.some((e) => e.type === 'stream_delta')).toBe(false)
    expect(ofType(quietEvents, 'turn_result')[0]).toMatchObject({ result: 'Hello' })
  })

  it('runs a full turn: handshake, thread/start, item mapping, summed usage', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/started', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'c1', type: 'commandExecution', command: 'ls', status: 'inProgress' },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'c1',
          type: 'commandExecution',
          command: 'ls',
          aggregatedOutput: 'file.txt\n',
          exitCode: 0,
          status: 'completed',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'f1',
          type: 'fileChange',
          changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '--- a\n+++ b\n' }],
          status: 'completed',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'r1', type: 'reasoning', summary: ['thought one', 'thought two'], content: [] },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'u0', type: 'userMessage', content: [{ type: 'text', text: 'go' }] },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'x1', type: 'exoticNovelty', detail: 42 },
      })
      emit('turn/plan/updated', {
        threadId: 'thread-1',
        turnId,
        plan: [
          { step: 'read', status: 'completed' },
          { step: 'write', status: 'inProgress' },
        ],
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'a1', type: 'agentMessage', text: 'done' },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_B, total: USAGE_B },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      permissionMode: 'acceptEdits',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()

    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'config/read', 'thread/start', 'skills/list', 'turn/start'])
    expect(peer.notifies).toEqual(['initialized'])
    expect(peer.requests[0]!.params).toMatchObject({ capabilities: { experimentalApi: true } })
    expect(peer.requests[1]!.params).toEqual({ cwd: '/tmp/project' })
    expect(peer.requests[2]!.params).toMatchObject({
      cwd: '/tmp/project',
      approvalPolicy: GRANULAR_ASK,
      sandbox: 'workspace-write',
      model: 'gpt-5.6-sol',
    })
    expect(peer.requests[4]!.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'go' }],
      cwd: '/tmp/project',
      approvalPolicy: GRANULAR_ASK,
      sandboxPolicy: { type: 'workspaceWrite' },
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(runner.sdkSessionId).toBe('thread-1')

    const types = events.map((e) => e.type)
    for (const forsworn of ['system_init']) {
      expect(types).not.toContain(forsworn)
    }
    expect(types).not.toContain('permission_requested')
    expect(types).not.toContain('context_usage')
    expect(types).not.toContain('rate_limit')
    expect(types).not.toContain('plan_info')

    const assistants = ofType(events, 'assistant_message')
    expect(
      assistants.some((e) =>
        (e.message.content as Array<{ type: string; thinking?: string }>).some(
          (b) => b.type === 'thinking' && b.thinking === 'thought one\n\nthought two',
        ),
      ),
    ).toBe(true)
    const commandUse = assistants.find(
      (e) => Array.isArray(e.message.content) && (e.message.content[0] as { name?: string }).name === 'CodexCommand',
    )!
    const commandBlock = ((e) => (e.message.content as Array<{ id: string }>)[0]!)(commandUse)
    expect(commandBlock.id).toMatch(/:c1$/)
    const results = ofType(events, 'user_message').filter((e) => e.synthetic)
    expect(
      results.some((e) => (e.message.content as Array<{ tool_use_id?: string; content?: string }>)[0]!.tool_use_id === commandBlock.id),
    ).toBe(true)
    const fileResult = results.find((e) => String((e.message.content as Array<{ content?: string }>)[0]!.content).includes('update: a.ts'))
    expect(fileResult).toBeDefined()
    expect(ofType(events, 'user_message').filter((e) => !e.synthetic)).toHaveLength(1)

    const sdkTypes = ofType(events, 'sdk_event').map((e) => e.payload.type)
    expect(sdkTypes).toContain('codex.exoticNovelty')
    expect(sdkTypes).toContain('codex.todo_list')
    const plan = ofType(events, 'sdk_event').find((e) => e.payload.type === 'codex.todo_list')!
    expect(plan.payload.items).toEqual([
      { text: 'read', completed: true },
      { text: 'write', completed: false },
    ])

    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'success',
      isError: false,
      result: 'done',
      numTurns: 1,
      totalCostUsd: 0,
      usage: {
        input_tokens: 200, // (600+400) - (500+300)
        output_tokens: 125, // (60+40) + (15+10)
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 800,
      },
    })
    expect(runner.status).toBe('idle')
  })

  it('maps a generated image to a tool card carrying its host path', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/started', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'g1',
          type: 'imageGeneration',
          status: 'inProgress',
          revisedPrompt: 'a pink flower, golden hour',
          result: '',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'g1',
          type: 'imageGeneration',
          status: 'completed',
          revisedPrompt: 'a pink flower, golden hour',
          result: 'ok',
          savedPath: '/Users/me/.codex/generated_images/flower.png',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'g2',
          type: 'imageGeneration',
          status: 'completed',
          result: 'x'.repeat(4000),
        },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })

    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'draw', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const uses = ofType(events, 'assistant_message').flatMap((e) =>
      (e.message.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>).filter(
        (b) => b.type === 'tool_use' && b.name === 'CodexImageGeneration',
      ),
    )
    expect(uses.length).toBeGreaterThanOrEqual(2)
    expect(uses.at(0)!.input).toEqual({ prompt: 'a pink flower, golden hour' })
    expect(uses.find((u) => u.id?.endsWith(':g1') && (u.input as { savedPath?: string }).savedPath)).toMatchObject({
      input: {
        prompt: 'a pink flower, golden hour',
        savedPath: '/Users/me/.codex/generated_images/flower.png',
      },
    })

    const results = ofType(events, 'user_message')
      .filter((e) => e.synthetic)
      .map((e) => (e.message.content as Array<{ content?: string }>)[0]!.content ?? '')
    expect(results.some((r) => r.includes('Saved to /Users/me/.codex/generated_images/flower.png'))).toBe(true)
    expect(results.some((r) => r.includes('xxxx'))).toBe(false)
    expect(results.some((r) => r.includes('No saved path reported'))).toBe(true)
    expect(ofType(events, 'sdk_event').map((e) => e.payload.type)).not.toContain('codex.imageGeneration')

    const produced = ofType(events, 'file_produced')
    expect(produced.map((e) => e.path)).toEqual(['/Users/me/.codex/generated_images/flower.png'])
    expect(produced[0]).toMatchObject({
      mediaType: 'image/png',
      toolUseId: expect.stringMatching(/:g1$/),
    })
    expect(produced[0]!.fileId).toMatch(/^[0-9a-f]{32}$/)
    expect(produced.length).toBe(1)
  })

  it("restates the operator's [sandbox_workspace_write] on every turn instead of clobbering it", async () => {
    const peer = scriptedPeer()
    peer.respond('config/read', () => ({
      config: {
        sandbox_workspace_write: {
          writable_roots: ['/tmp/extra'],
          network_access: true,
          exclude_tmpdir_env_var: false,
          exclude_slash_tmp: true,
        },
      },
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      permissionMode: 'acceptEdits',
      connectFn: peer.connectFn,
    })
    collect(runner)
    await runner.start()
    expect(peer.requests.find((r) => r.method === 'config/read')?.params).toEqual({
      cwd: '/tmp/project',
    })
    expect(peer.requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/extra'],
        networkAccess: true,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: true,
      },
    })
  })

  it('leaves read-only alone — network_access is scoped to workspace-write', async () => {
    const peer = scriptedPeer()
    peer.respond('config/read', () => ({
      config: { sandbox_workspace_write: { writable_roots: [], network_access: true } },
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      permissionMode: 'default',
      connectFn: peer.connectFn,
    })
    collect(runner)
    await runner.start()
    expect(peer.requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'readOnly' },
    })
  })

  it('falls back to the bare policy shape when config/read is unavailable', async () => {
    const peer = scriptedPeer()
    peer.respond('config/read', () => {
      throw new JsonRpcError(-32601, 'unknown variant `config/read`')
    })
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      permissionMode: 'acceptEdits',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(peer.requests.find((r) => r.method === 'turn/start')?.params).toMatchObject({
      sandboxPolicy: { type: 'workspaceWrite' },
    })
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })
})
