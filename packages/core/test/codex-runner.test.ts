import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import type {
  AppServerConnectFn,
  AppServerConnection,
} from '../src/engines/codex/types.ts'

const THREAD_RESULT = {
  thread: { id: 'thread-1' },
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
}

const USAGE_A = {
  inputTokens: 600,
  cachedInputTokens: 500,
  cacheWriteInputTokens: 30,
  outputTokens: 60,
  reasoningOutputTokens: 15,
  totalTokens: 675,
}
const USAGE_B = {
  inputTokens: 400,
  cachedInputTokens: 300,
  cacheWriteInputTokens: 20,
  outputTokens: 40,
  reasoningOutputTokens: 10,
  totalTokens: 450,
}

/**
 * The `queryFn` injection pattern at the wire level: a scripted JSON-RPC peer. Requests are
 * recorded and answered by method responders; the test emits server→client
 * notifications and requests through the handlers the runner registered.
 */
function scriptedPeer() {
  const requests: Array<{ method: string; params: unknown; connection: number }> = []
  const notifies: string[] = []
  const envs: Array<Record<string, string>> = []
  const responders = new Map<string, (params: unknown) => unknown>()
  let connectCount = 0
  let closedCount = 0
  let notificationHandler: ((method: string, params: unknown) => void) | undefined
  let requestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined
  let closeHandler: ((message: string) => void) | undefined

  responders.set('initialize', () => ({ codexHome: '/tmp/.codex' }))
  responders.set('thread/start', () => THREAD_RESULT)
  responders.set('thread/resume', () => THREAD_RESULT)

  const connectFn: AppServerConnectFn = (options) => {
    envs.push(options.env)
    const connection = ++connectCount
    const peer: AppServerConnection = {
      request: async (method, params) => {
        requests.push({ method, params, connection })
        const responder = responders.get(method)
        if (!responder) return {}
        return responder(params)
      },
      notify: (method) => {
        notifies.push(method)
      },
      onNotification: (handler) => {
        notificationHandler = handler
      },
      onRequest: (handler) => {
        requestHandler = handler
      },
      onClose: (handler) => {
        closeHandler = handler
      },
      close: () => {
        closedCount++
      },
    }
    return peer
  }

  return {
    connectFn,
    requests,
    notifies,
    envs,
    respond: (method: string, responder: (params: unknown) => unknown) =>
      responders.set(method, responder),
    emit: (method: string, params: unknown) => notificationHandler!(method, params),
    serverRequest: (method: string, params: unknown) => requestHandler!(method, params),
    die: (message: string) => closeHandler!(message),
    connections: () => connectCount,
    closed: () => closedCount,
  }
}

/** Scripted happy-path turn: deltas, items, usage, completion — all emitted
 * synchronously from inside the turn/start responder. */
function scriptTurn(
  peer: ReturnType<typeof scriptedPeer>,
  script: (emit: (method: string, params: unknown) => void, turnId: string) => void,
  turnId = 'turn-1',
) {
  peer.respond('turn/start', () => {
    peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
    script(peer.emit, turnId)
    return { turn: { id: turnId, status: 'inProgress' } }
  })
}

function collect(runner: CodexRunner): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  return events
}

function ofType<T extends SessionEvent['type']>(
  events: SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> {
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
}

describe('CodexRunner', () => {
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
    const deltas = ofType(events, 'stream_delta').map(
      (e) => e.event.delta as { text?: string; thinking?: string },
    )
    expect(deltas.map((d) => d.thinking ?? d.text)).toEqual([
      'First',
      ' part',
      '\n\nSecond', // the summaryIndex bump renders as a paragraph break
      'He',
      'llo',
    ])
    // The completed message supersedes the stream, exec-style.
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
    // Suppressing deltas must not suppress the answer.
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

    // The JSON-RPC choreography: initialize → (initialized) → thread/start → turn/start.
    expect(peer.requests.map((r) => r.method)).toEqual(['initialize', 'thread/start', 'turn/start'])
    expect(peer.notifies).toEqual(['initialized'])
    expect(peer.requests[1]!.params).toMatchObject({
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: 'gpt-5.6-sol',
    })
    expect(peer.requests[2]!.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'go' }],
      cwd: '/tmp/project',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'workspaceWrite' },
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(runner.sdkSessionId).toBe('thread-1')

    // The record's forsworn events never occur.
    const types = events.map((e) => e.type)
    for (const forsworn of ['system_init', 'permission_requested']) {
      expect(types).not.toContain(forsworn)
    }
    // context_usage and rate_limit are NOT forsworn — the record declares both.
    // They are absent here because this turn reported neither a
    // `modelContextWindow` nor an `account/rateLimits/updated`, and a reading
    // without its window (or without a percentage) is not a reading: the
    // protocol is explicit that a client renders nothing rather than 0%.
    expect(types).not.toContain('context_usage')
    expect(types).not.toContain('rate_limit')
    expect(types).not.toContain('plan_info')

    const assistants = ofType(events, 'assistant_message')
    // Reasoning: its own thinking message, sections joined as paragraphs.
    expect(assistants.some((e) =>
      (e.message.content as Array<{ type: string; thinking?: string }>).some(
        (b) => b.type === 'thinking' && b.thinking === 'thought one\n\nthought two',
      ),
    )).toBe(true)
    // Command execution: tool_use at item/started, paired tool_result at completion,
    // ids per-turn-namespaced with the raw id surviving as the suffix.
    const commandUse = assistants.find(
      (e) =>
        Array.isArray(e.message.content) &&
        (e.message.content[0] as { name?: string }).name === 'CodexCommand',
    )!
    const commandBlock = (e => (e.message.content as Array<{ id: string }>)[0]!)(commandUse)
    expect(commandBlock.id).toMatch(/:c1$/)
    const results = ofType(events, 'user_message').filter((e) => e.synthetic)
    expect(
      results.some(
        (e) =>
          (e.message.content as Array<{ tool_use_id?: string; content?: string }>)[0]!
            .tool_use_id === commandBlock.id,
      ),
    ).toBe(true)
    // v2's object kind renders like exec's string kind did.
    const fileResult = results.find((e) =>
      String((e.message.content as Array<{ content?: string }>)[0]!.content).includes('update: a.ts'),
    )
    expect(fileResult).toBeDefined()
    // The user's own echoed item is dropped: exactly one non-synthetic user message.
    expect(ofType(events, 'user_message').filter((e) => !e.synthetic)).toHaveLength(1)

    // Unknown items and the plan ride sdk_event, exec-style.
    const sdkTypes = ofType(events, 'sdk_event').map((e) => e.payload.type)
    expect(sdkTypes).toContain('codex.exoticNovelty')
    expect(sdkTypes).toContain('codex.todo_list')
    const plan = ofType(events, 'sdk_event').find((e) => e.payload.type === 'codex.todo_list')!
    expect(plan.payload.items).toEqual([
      { text: 'read', completed: true },
      { text: 'write', completed: false },
    ])

    // Usage: summed across the turn's updates, Anthropic convention (input
    // excludes cache, reasoning is output), totalCostUsd 0 = unknown.
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

  it('interrupts via turn/interrupt and lands as an interrupted turn result', async () => {
    const peer = scriptedPeer()
    // A turn that starts and hangs (the responder returns without a terminal).
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 'turn-9', status: 'inProgress' } })
      return { turn: { id: 'turn-9', status: 'inProgress' } }
    })
    peer.respond('turn/interrupt', () => {
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-9', status: 'interrupted' } })
      return {}
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'spin', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.status).toBe('running'))
    await runner.interrupt()
    await run
    expect(peer.requests.find((r) => r.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-9',
    })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['interrupted'],
    })
    expect(runner.status).toBe('idle')
  })

  it('resumes: a create-request resume goes through thread/resume, and a dead child respawns into the same thread', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'a1', type: 'agentMessage', text: 'back' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'continue',
      resume: 'prior-thread',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(peer.requests[1]).toMatchObject({
      method: 'thread/resume',
      params: { threadId: 'prior-thread' },
      connection: 1,
    })
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', result: 'back' })

    // The child dies while idle; the next message spawns a fresh one and
    // resumes the SAME thread — a dead child is never a dead session.
    peer.die('codex app-server exited (code 1): boom')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    const resumed = peer.requests.filter((r) => r.method === 'thread/resume')
    expect(resumed).toHaveLength(2)
    expect(resumed[1]).toMatchObject({ params: { threadId: 'thread-1' }, connection: 2 })
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('fails the in-flight turn with the exit diagnostic when the child dies mid-turn', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't', status: 'inProgress' } })
      return { turn: { id: 't', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.status).toBe('running'))
    peer.die('codex app-server exited (SIGKILL): stderr tail here')
    await run
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['codex app-server exited (SIGKILL): stderr tail here'],
    })
    expect(runner.status).toBe('idle')
  })

  it('treats a failed turn as a failed turn — turn/completed(status failed) with its error', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('error', {
        threadId: 'thread-1',
        turnId: 't',
        error: { message: 'Reconnecting… 1/5' },
        willRetry: true,
      })
      peer.emit('turn/completed', {
        threadId: 'thread-1',
        turn: { id: 't', status: 'failed', error: { message: '401 Unauthorized' } },
      })
      return { turn: { id: 't', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['401 Unauthorized'],
    })
    expect(runner.status).toBe('idle')
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('namespaces item ids per turn — one long-lived child never publishes colliding ids', async () => {
    const peer = scriptedPeer()
    const answer = (text: string) => (emit: (m: string, p: unknown) => void, turnId: string) => {
      emit('item/started', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_0', type: 'commandExecution', command: 'ls', status: 'inProgress' },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: {
          id: 'item_0',
          type: 'commandExecution',
          command: 'ls',
          aggregatedOutput: 'ok\n',
          exitCode: 0,
          status: 'completed',
        },
      })
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item_1', type: 'agentMessage', text },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    }
    let turnIndex = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++turnIndex}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      answer(turnIndex === 1 ? 'four' : 'six')(peer.emit, turnId)
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('2+2')
    runner.sendMessage('3+3')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))

    const answers = ofType(events, 'assistant_message').filter(
      (e) => Array.isArray(e.message.content) && e.message.content[0]!.type === 'text',
    )
    expect(answers.map((e) => (e.message.content as Array<{ text: string }>)[0]!.text)).toEqual([
      'four',
      'six',
    ])
    expect(answers[0]!.uuid).not.toBe(answers[1]!.uuid)
    for (const a of answers) expect(a.uuid).toMatch(/:item_1$/)

    const uses = ofType(events, 'assistant_message')
      .map((e) => (e.message.content as Array<{ type: string; id?: string }>)[0]!)
      .filter((block) => block.type === 'tool_use')
    expect(uses).toHaveLength(2)
    expect(uses[0]!.id).not.toBe(uses[1]!.id)
    const resultIds = ofType(events, 'user_message')
      .filter((e) => e.synthetic)
      .map((e) => (e.message.content as Array<{ tool_use_id: string }>)[0]!.tool_use_id)
    expect(resultIds).toEqual([uses[0]!.id, uses[1]!.id])
  })

  it('applies model/mode between turns, resets to the resolved default, refuses mid-turn', async () => {
    const peer = scriptedPeer()
    let turnIndex = 0
    peer.respond('turn/start', () => {
      const turnId = `turn-${++turnIndex}`
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: turnId, status: 'inProgress' } })
      if (turnIndex < 3) {
        peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      } // turn 3 hangs for the mid-turn refusals
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()
    // No model configured: the resolved default from thread/start is named
    // explicitly (overrides persist per thread, so every turn states its model).
    const turnParams = () => peer.requests.filter((r) => r.method === 'turn/start')
    expect(turnParams()[0]!.params).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'medium',
      sandboxPolicy: { type: 'readOnly' },
    })

    await runner.setModel('gpt-5.5')
    await runner.setPermissionMode('bypassPermissions')
    runner.sendMessage('next')
    await vi.waitFor(() => expect(turnParams()).toHaveLength(2))
    expect(turnParams()[1]!.params).toMatchObject({
      model: 'gpt-5.5',
      sandboxPolicy: { type: 'dangerFullAccess' },
    })
    expect(runner.info().model).toBe('gpt-5.5')

    // Back to default — possible because the resolved default is remembered.
    await runner.setModel(undefined)
    expect(runner.info().model).toBe('gpt-5.6-terra')

    runner.sendMessage('spin')
    await vi.waitFor(() => expect(turnParams()).toHaveLength(3))
    expect(turnParams()[2]!.params).toMatchObject({ model: 'gpt-5.6-terra' })
    await expect(runner.setModel('gpt-5.2')).rejects.toThrow(/mid-turn/)
    await expect(runner.setPermissionMode('default')).rejects.toThrow(/mid-turn/)
    runner.close()
  })

  it('auto-declines server→client approval requests, visibly, and errors the unknown', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    await expect(
      peer.serverRequest('item/commandExecution/requestApproval', { itemId: 'c1' }),
    ).resolves.toEqual({ decision: 'decline' })
    await expect(peer.serverRequest('item/permissions/requestApproval', {})).resolves.toEqual({
      permissions: {},
    })
    await expect(peer.serverRequest('mcpServer/elicitation/request', {})).resolves.toEqual({
      action: 'decline',
    })
    await expect(peer.serverRequest('account/chatgptAuthTokens/refresh', {})).rejects.toMatchObject({
      code: -32601,
    })
    const declined = ofType(events, 'sdk_event').filter(
      (e) => e.payload.type === 'codex.approval_auto_declined',
    )
    expect(declined.map((e) => e.payload.method)).toEqual([
      'item/commandExecution/requestApproval',
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
    ])
  })

  it('hands images to codex as localImage temp files and cleans up on close', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    void runner.start()
    const pixel =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    runner.sendMessage('what is this?', [
      { id: 'att-1', name: 'pixel.png', mediaType: 'image/png', bytes: 68, data: pixel },
      {
        id: 'att-2',
        name: 'notes.txt',
        mediaType: 'text/plain',
        bytes: 5,
        data: Buffer.from('hello').toString('base64'),
      },
    ])
    await vi.waitFor(() =>
      expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(true),
    )
    const input = (peer.requests.find((r) => r.method === 'turn/start')!.params as {
      input: Array<{ type: string; path?: string; text?: string }>
    }).input
    const image = input.find((p) => p.type === 'localImage')!
    expect(image.path).toMatch(/att-1\.png$/)
    expect(existsSync(image.path!)).toBe(true)
    expect(readFileSync(image.path!).equals(Buffer.from(pixel, 'base64'))).toBe(true)
    const texts = input.filter((p) => p.type === 'text').map((p) => p.text)
    expect(texts[0]).toContain('<attachment name="notes.txt" type="text/plain">')
    expect(texts[1]).toBe('what is this?')

    runner.close()
    expect(existsSync(image.path!)).toBe(false)
    expect(peer.closed()).toBe(1)

    const pdfPeer = scriptedPeer()
    const pdfRunner = new CodexRunner({ cwd: '/tmp', connectFn: pdfPeer.connectFn })
    void pdfRunner.start()
    expect(() =>
      pdfRunner.sendMessage('read this', [
        { id: 'a', name: 'doc.pdf', mediaType: 'application/pdf', bytes: 4, data: 'JVBERg==' },
      ]),
    ).toThrow(/unsupported attachment/)
  })

  it('passes a complete child env with the CODEX_HOME pin winning, on every spawn', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      connectFn: peer.connectFn,
      env: { PATH: '/usr/bin', HOME: '/Users/op', CODEX_HOME: '/elsewhere', GONE: undefined },
      codexHome: '/profiles/codex-a',
    })
    await runner.start()
    expect(peer.envs[0]).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/op',
      CODEX_HOME: '/profiles/codex-a',
    })
  })

  it('reports codex identity and the token-streaming capability record on info()', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp/w',
      prompt: 'hello world',
      connectFn: peer.connectFn,
    })
    await runner.start()
    const info = runner.info()
    expect(info.engine).toBe('codex')
    expect(info.capabilities?.streaming).toBe('token')
    expect(info.capabilities?.interactiveApprovals).toBe(false)
    expect(info.sdkSessionId).toBe('thread-1')
    expect(info.pendingPermissionCount).toBe(0)
    expect(info.title).toBe('hello world')
  })

  it('measures context occupancy from `last`, never the cumulative `total`', async () => {
    // Two model requests in one turn, as a tool-looping turn produces. `total`
    // is cumulative billing and grows every request; `last` is the occupancy of
    // the window, because a request's input already carries the conversation.
    // Sizing the meter off `total` would climb toward 100% on an almost-empty
    // thread — measured against the real binary at 13931 → 27878 total while
    // last stayed ~13.9k of a 258400 window.
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A, modelContextWindow: 1000 },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: {
          last: USAGE_B,
          total: { ...USAGE_A, totalTokens: USAGE_A.totalTokens + USAGE_B.totalTokens },
          modelContextWindow: 1000,
        },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp/w', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const [usage] = ofType(events, 'context_usage')
    expect(usage).toBeDefined()
    // USAGE_B.totalTokens (the LAST request), not 675 + 450.
    expect(usage!.usage.totalTokens).toBe(USAGE_B.totalTokens)
    expect(usage!.usage.maxTokens).toBe(1000)
    expect(usage!.usage.percentage).toBeCloseTo(45)
    // No breakdown exists on this surface — an empty list, never a fabricated row.
    expect(usage!.usage.categories).toEqual([])
    // Per-turn token accounting still SUMS, which is the opposite choice and
    // deliberately so: it is billing, not occupancy.
    const [result] = ofType(events, 'turn_result')
    expect(result!.usage).toMatchObject({
      output_tokens:
        USAGE_A.outputTokens +
        USAGE_A.reasoningOutputTokens +
        USAGE_B.outputTokens +
        USAGE_B.reasoningOutputTokens,
    })
  })

  it('names codex rate-limit windows by their measured duration, and plans once', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_518_770 },
          secondary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: 1_786_600_000 },
          planType: 'plus',
          rateLimitReachedType: null,
        },
      })
      // A second update with the same plan must not re-announce it, and an
      // unnamed duration keeps a self-describing key rather than borrowing one.
      emit('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 90, windowDurationMins: 43_200 },
          secondary: { usedPercent: null, windowDurationMins: 10_080 },
          planType: 'plus',
          rateLimitReachedType: 'primary',
        },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp/w', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const limits = ofType(events, 'rate_limit').map((e) => e.info)
    // 300 min IS five hours and 10080 IS seven days — the names clients already
    // label and size their pace markers from.
    expect(limits[0]).toMatchObject({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 12,
      resetsAt: 1_786_518_770,
    })
    expect(limits[1]).toMatchObject({ rateLimitType: 'seven_day', utilization: 43 })
    // Second update: unnamed duration stays self-describing; a null percentage
    // is unknown, not zero, so that window is dropped entirely.
    expect(limits[2]).toMatchObject({
      status: 'rejected',
      rateLimitType: 'window_43200m',
      utilization: 90,
    })
    expect(limits[2]!.resetsAt).toBeUndefined()
    expect(limits).toHaveLength(3)

    // plan_info names the windows once, not per update.
    const plans = ofType(events, 'plan_info')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.subscriptionType).toBe('plus')
  })

  it('refuses forkSession and CLI-only permission modes at construction', () => {
    const peer = scriptedPeer()
    expect(
      () =>
        new CodexRunner({ cwd: '/tmp', resume: 't', forkSession: true, connectFn: peer.connectFn }),
    ).toThrow(/fork/)
    expect(
      () => new CodexRunner({ cwd: '/tmp', permissionMode: 'plan', connectFn: peer.connectFn }),
    ).toThrow(/not supported/)
  })

  it('fails the turn when turn/start itself is rejected, and stays usable', async () => {
    const peer = scriptedPeer()
    let attempts = 0
    peer.respond('turn/start', () => {
      if (++attempts === 1) throw new Error('invalid params: input')
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't2', status: 'completed' } })
      return { turn: { id: 't2', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['invalid params: input'],
    })
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
  })
})
