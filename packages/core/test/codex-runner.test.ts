import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import type {
  AppServerConnectFn,
  AppServerConnection,
} from '../src/engines/codex/types.ts'

const THREAD_RESULT = {
  thread: { id: 'thread-1' },
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
}

/** The wire shape of the ask policy (default/acceptEdits) and its all-off
 * mirror (bypassPermissions) — granular objects, never the string vocabulary
 * (plain 'untrusted' never asks; measured against 0.146.0). */
const GRANULAR_ASK = {
  granular: {
    sandbox_approval: true,
    rules: true,
    mcp_elicitations: true,
    request_permissions: true,
    skill_approval: true,
  },
}
const GRANULAR_NEVER = {
  granular: {
    sandbox_approval: false,
    rules: false,
    mcp_elicitations: false,
    request_permissions: false,
    skill_approval: false,
  },
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
  let requestHandler:
    | ((method: string, params: unknown, id: string | number) => Promise<unknown>)
    | undefined
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
    serverRequest: (method: string, params: unknown, id: string | number = 'wire-1') =>
      requestHandler!(method, params, id),
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

    // The JSON-RPC choreography: initialize → (initialized) → thread/start →
    // skills/list → turn/start. skills/list rides the same thread-load seam
    // (it needs a live child and nothing else), and being fire-and-forget it
    // must not delay the turn — which is why it lands before it, not instead.
    expect(peer.requests.map((r) => r.method)).toEqual([
      'initialize',
      'thread/start',
      'skills/list',
      'turn/start',
    ])
    expect(peer.notifies).toEqual(['initialized'])
    // experimentalApi is unconditional — granular approval policies are
    // rejected without it, and there is no non-experimental fallback.
    expect(peer.requests[0]!.params).toMatchObject({ capabilities: { experimentalApi: true } })
    expect(peer.requests[1]!.params).toMatchObject({
      cwd: '/tmp/project',
      approvalPolicy: GRANULAR_ASK,
      sandbox: 'workspace-write',
      model: 'gpt-5.6-sol',
    })
    expect(peer.requests[3]!.params).toMatchObject({
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'go' }],
      cwd: '/tmp/project',
      approvalPolicy: GRANULAR_ASK,
      sandboxPolicy: { type: 'workspaceWrite' },
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(runner.sdkSessionId).toBe('thread-1')

    // The record's forsworn events never occur. (permission_requested is no
    // longer forsworn — approvals are wired — but this quiet turn asks none.)
    const types = events.map((e) => e.type)
    for (const forsworn of ['system_init']) {
      expect(types).not.toContain(forsworn)
    }
    expect(types).not.toContain('permission_requested')
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

  it('maps a generated image to a tool card carrying its host path', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      // While it runs there is no path yet — only the prompt.
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
      // A result long enough to be an encoded image never reaches the log.
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

    // The finished card carries the path as a *field*, which is what a client
    // keys an inline preview off — not a sentence it would have to parse.
    const uses = ofType(events, 'assistant_message').flatMap((e) =>
      (e.message.content as Array<{ type: string; id?: string; name?: string; input?: unknown }>)
        .filter((b) => b.type === 'tool_use' && b.name === 'CodexImageGeneration'),
    )
    expect(uses.length).toBeGreaterThanOrEqual(2)
    expect(uses.at(0)!.input).toEqual({ prompt: 'a pink flower, golden hour' })
    expect(uses.find((u) => u.id?.endsWith(':g1') && (u.input as { savedPath?: string }).savedPath))
      .toMatchObject({
        input: {
          prompt: 'a pink flower, golden hour',
          savedPath: '/Users/me/.codex/generated_images/flower.png',
        },
      })

    const results = ofType(events, 'user_message')
      .filter((e) => e.synthetic)
      .map((e) => (e.message.content as Array<{ content?: string }>)[0]!.content ?? '')
    expect(results.some((r) => r.includes('Saved to /Users/me/.codex/generated_images/flower.png')))
      .toBe(true)
    // Never a 4000-character blob: an undocumented free-form field is not a
    // licence to put an encoded image in the event log.
    expect(results.some((r) => r.includes('xxxx'))).toBe(false)
    expect(results.some((r) => r.includes('No saved path reported'))).toBe(true)
    // It is not swallowed into the unknown-item channel any more.
    expect(ofType(events, 'sdk_event').map((e) => e.payload.type)).not.toContain(
      'codex.imageGeneration',
    )

    // …and the path is announced as a produced file, which is what makes the
    // bytes fetchable without the operator declaring `$CODEX_HOME` as a
    // host-file root. ONE announcement despite the path being reported on both
    // the progress and completed item: the id derives from the path.
    const produced = ofType(events, 'file_produced')
    expect(produced.map((e) => e.path)).toEqual([
      '/Users/me/.codex/generated_images/flower.png',
    ])
    expect(produced[0]).toMatchObject({
      mediaType: 'image/png',
      toolUseId: expect.stringMatching(/:g1$/),
    })
    // Stable, and derived: the same path in a rebuilt session gets the same id,
    // so a client's cached URL survives a park/restore.
    expect(produced[0]!.fileId).toMatch(/^[0-9a-f]{32}$/)
    // A generation with no savedPath announces nothing — there is no file.
    expect(produced.length).toBe(1)
  })

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
              // Second page, same skill: codex can report one skill under
              // several cwds and the first wins.
              { name: 'imagegen', description: 'duplicate', scope: 'repo' },
              ...(listCalls > 1
                ? [{ name: 'pdf-fill', description: 'Fill PDF forms', enabled: false }]
                : []),
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

    // The session's cwd is passed EXPLICITLY. Omitting it does not fall back to
    // the thread's directory — measured against 0.146.0, it falls back to the
    // app-server child's own process cwd, and a project's `.codex/skills/**`
    // are then invisible. This assertion is the guard on that.
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
        // Codex's own suggested opener — the field that makes a picker possible
        // without pretending `/imagegen` is a command.
        defaultPrompt: 'Generate an image of',
        scope: 'user',
        enabled: true,
      },
    ])

    // The watcher fires; the list is re-read and the new skill published.
    peer.emit('skills/changed', {})
    await vi.waitFor(() => expect(ofType(events, 'skills')).toHaveLength(2))
    const second = ofType(events, 'skills')[1]!
    expect(second.skills.map((s) => s.name)).toEqual(['imagegen', 'pdf-fill'])
    // Listed, not hidden: "installed but off" is a different answer from
    // "not installed".
    expect(second.skills[1]).toMatchObject({ name: 'pdf-fill', enabled: false })

    // An unchanged list does not re-publish — the watcher fires per touched
    // file and an event per keystroke would fill the log with identical rows.
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

    // Promptless and not resuming: the dashboard's "create a session, then type"
    // flow. Nothing else would bring a child up, so without the probe this
    // session would have no skill list at all until its first turn — the one
    // place codex's own TUI has them and we did not.
    const runner = new CodexRunner({ cwd: '/tmp/project', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()

    await vi.waitFor(() => expect(ofType(events, 'skills')).toHaveLength(1))
    expect(ofType(events, 'skills')[0]!.skills.map((s) => s.name)).toEqual(['scratch-notes'])
    // Thrown away, not adopted: no thread was started on it, and it is closed.
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

    // A prompt means a turn, which means a child within moments. A second
    // spawn just to ask the same question would be pure waste.
    const runner = new CodexRunner({ cwd: '/tmp/p', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()

    expect(peer.connections()).toBe(1)
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

    // A binary too old to list skills is a session with no skills panel — not
    // a session error, and not a failed turn.
    expect(ofType(events, 'skills')).toHaveLength(0)
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
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
      // bypassPermissions asks NOTHING — same granular shape, all flags off.
      approvalPolicy: GRANULAR_NEVER,
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

  it('surfaces a command escalation as permission_requested and accepts on allow', async () => {
    // The real shape, measured against 0.146.0: the command already RAN inside
    // the read-only sandbox and was refused — the approval is an escalation
    // ("command failed; retry without sandbox?"), not a pre-execution gate.
    const peer = scriptedPeer()
    let approvalResponse: unknown
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      peer.emit('item/started', {
        threadId: 'thread-1',
        turnId: 't1',
        item: { id: 'exec-1', type: 'commandExecution', command: 'printf x > /tmp/p.txt', status: 'inProgress' },
      })
      void peer
        .serverRequest('item/commandExecution/requestApproval', {
          threadId: 'thread-1',
          turnId: 't1',
          itemId: 'exec-1',
          command: 'printf x > /tmp/p.txt',
          cwd: '/tmp',
          reason: 'command failed; retry without sandbox?',
          availableDecisions: [
            'accept',
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['printf'] } },
            'cancel',
          ],
        })
        .then((response) => {
          approvalResponse = response
          peer.emit('item/completed', {
            threadId: 'thread-1',
            turnId: 't1',
            item: {
              id: 'exec-1',
              type: 'commandExecution',
              command: 'printf x > /tmp/p.txt',
              aggregatedOutput: '',
              exitCode: 0,
              status: 'completed',
            },
          })
          peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
        })
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(ofType(events, 'permission_requested')).toHaveLength(1))

    const request = ofType(events, 'permission_requested')[0]!.request
    // Codex's own reason sentence IS the headline — the honest tense (the
    // command already ran and was blocked; approving re-runs it unsandboxed).
    expect(request.toolName).toBe('CodexCommand')
    expect(request.title).toBe('command failed; retry without sandbox?')
    expect(request.decisionReason).toBe('command failed; retry without sandbox?')
    expect(request.input).toMatchObject({ command: 'printf x > /tmp/p.txt', cwd: '/tmp' })
    expect(request.expiresAt).toBeGreaterThan(Date.now())
    // Anchored to the tool card the item already produced.
    const use = ofType(events, 'assistant_message')
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .find((b) => b.type === 'tool_use') as { id: string }
    expect(request.toolUseId).toBe(use.id)
    expect(runner.status).toBe('awaiting_approval')
    expect(runner.info().pendingPermissionCount).toBe(1)
    expect(runner.pendingApprovals.map((r) => r.id)).toEqual([request.id])

    expect(runner.resolvePermission(request.id, { behavior: 'allow' })).toBe(true)
    await run
    expect(approvalResponse).toEqual({ decision: 'accept' })
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      requestId: request.id,
      behavior: 'allow',
      resolvedBy: 'client',
    })
    expect(runner.status).toBe('idle')
    expect(runner.info().pendingPermissionCount).toBe(0)
    // Unknown ids (already settled) answer false.
    expect(runner.resolvePermission(request.id, { behavior: 'allow' })).toBe(false)
  })

  it('denies with decline, cancels only when interrupting, and never invents an accept', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    // Deny → 'decline', even when availableDecisions omits it: the response
    // schema declares decline unconditionally and a live decline against this
    // exact shape completed cleanly (0.146.0) — the list gates the accept
    // variants, it does not take "no, but keep going" away ('cancel', its only
    // listed alternative, would interrupt the whole turn).
    const deny = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c1',
      command: 'rm -rf /',
      availableDecisions: ['accept', 'cancel'],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, {
      behavior: 'deny',
      message: 'no thanks',
    })
    await expect(deny).resolves.toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'client',
      message: 'no thanks',
    })

    // Deny+interrupt → 'cancel' (codex's own deny-and-interrupt decision).
    const cancel = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c2',
      command: 'sleep 999',
      availableDecisions: ['accept', 'cancel'],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny', interrupt: true })
    await expect(cancel).resolves.toEqual({ decision: 'cancel' })

    // An allow the request offered no plain accept for is NEVER widened into a
    // broader grant — the runner answers with the denial and says why.
    const noAccept = peer.serverRequest('item/commandExecution/requestApproval', {
      threadId: 'thread-1',
      itemId: 'c3',
      command: 'echo hi',
      availableDecisions: [
        'acceptForSession',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } },
        'cancel',
      ],
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await expect(noAccept).resolves.toEqual({ decision: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
      message: expect.stringContaining('no plain accept'),
    })

    // Unhandled server requests still get -32601, never a hang.
    await expect(peer.serverRequest('account/chatgptAuthTokens/refresh', {})).rejects.toMatchObject({
      code: -32601,
    })
  })

  it('times out an unanswered approval without wedging the turn', async () => {
    const peer = scriptedPeer()
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      void peer
        .serverRequest('item/fileChange/requestApproval', {
          threadId: 'thread-1',
          turnId: 't1',
          itemId: 'f1',
          grantRoot: '/tmp/project',
        })
        .then((response) => {
          expect(response).toEqual({ decision: 'decline' })
          peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
        })
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      approvalTimeoutMs: 25,
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'permission_requested')[0]!.request).toMatchObject({
      toolName: 'CodexFileChange',
      input: { grantRoot: '/tmp/project' },
    })
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'timeout',
      message: 'Approval timed out',
    })
    expect(runner.status).toBe('idle')
    // The runner stays usable after the timeout.
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    }, 't2')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
  })

  it('maps requestUserInput onto the AskUserQuestion convention, with question policies', async () => {
    const QUESTIONS = {
      threadId: 'thread-1',
      turnId: 't1',
      itemId: 'q-item',
      questions: [
        {
          id: 'q1',
          header: 'Auth',
          question: 'Which auth method?',
          options: [
            { label: 'OAuth', description: 'browser flow' },
            { label: 'API key', description: 'env var' },
          ],
        },
      ],
    }
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    await runner.start()

    // 'ask' (default): pending, in the exact UserQuestion wire shape the
    // existing QuestionPrompt UIs parse; the allow's `updatedInput.answers`
    // (question text → chosen label) maps back to codex's id-keyed shape.
    const asked = peer.serverRequest('item/tool/requestUserInput', QUESTIONS)
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    const request = runner.pendingApprovals[0]!
    expect(request.toolName).toBe('AskUserQuestion')
    expect(request.input).toEqual({
      questions: [
        {
          question: 'Which auth method?',
          header: 'Auth',
          options: [
            { label: 'OAuth', description: 'browser flow' },
            { label: 'API key', description: 'env var' },
          ],
        },
      ],
    })
    runner.resolvePermission(request.id, {
      behavior: 'allow',
      updatedInput: { answers: { 'Which auth method?': 'API key' } },
    })
    await expect(asked).resolves.toEqual({ answers: { q1: { answers: ['API key'] } } })

    // 'auto': settled synchronously with each question's first (recommended)
    // option — request/resolved events still fire, nothing pends.
    const autoPeer = scriptedPeer()
    scriptTurn(autoPeer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const auto = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      questionBehavior: 'auto',
      connectFn: autoPeer.connectFn,
    })
    const autoEvents = collect(auto)
    await auto.start()
    await expect(autoPeer.serverRequest('item/tool/requestUserInput', QUESTIONS)).resolves.toEqual({
      answers: { q1: { answers: ['OAuth'] } },
    })
    expect(auto.pendingApprovals).toHaveLength(0)
    expect(ofType(autoEvents, 'permission_resolved')[0]).toMatchObject({
      behavior: 'allow',
      resolvedBy: 'policy',
    })

    // 'deny': the model is sent back to decide, with the guidance message.
    const denyPeer = scriptedPeer()
    scriptTurn(denyPeer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const denied = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      questionBehavior: 'deny',
      connectFn: denyPeer.connectFn,
    })
    const deniedEvents = collect(denied)
    await denied.start()
    await expect(denyPeer.serverRequest('item/tool/requestUserInput', QUESTIONS)).resolves.toEqual({
      answers: {},
    })
    expect(ofType(deniedEvents, 'permission_resolved')[0]).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
    })
  })

  it('grants exactly the requested permission profile on allow, nothing on deny or teardown', async () => {
    const PROFILE = { fileSystem: { write: ['/tmp/project'] } }
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const granted = peer.serverRequest('item/permissions/requestApproval', {
      threadId: 'thread-1',
      itemId: 'p1',
      permissions: PROFILE,
      reason: 'need to write build output',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    expect(runner.pendingApprovals[0]).toMatchObject({
      toolName: 'CodexPermissions',
      title: 'need to write build output',
    })
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    // The grant echoes the REQUESTED profile — turn-scoped by default, never a
    // widened one.
    await expect(granted).resolves.toEqual({ permissions: PROFILE })

    const refused = peer.serverRequest('item/permissions/requestApproval', {
      threadId: 'thread-1',
      itemId: 'p2',
      permissions: PROFILE,
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny' })
    await expect(refused).resolves.toEqual({ permissions: {} })

    // An MCP elicitation allow carries the filled form as content; deny declines.
    const elicited = peer.serverRequest('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      serverName: 'deepwiki',
      message: 'API token?',
      mode: 'form',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    expect(runner.pendingApprovals[0]!.toolName).toBe('CodexMcpElicitation')
    runner.resolvePermission(runner.pendingApprovals[0]!.id, {
      behavior: 'allow',
      updatedInput: { token: 'abc' },
    })
    await expect(elicited).resolves.toEqual({ action: 'accept', content: { token: 'abc' } })

    // Session close settles what's left with the channel's own "no".
    const orphan = peer.serverRequest('mcpServer/elicitation/request', {
      threadId: 'thread-1',
      serverName: 'deepwiki',
      message: 'still there?',
      mode: 'form',
    })
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(1))
    runner.close()
    await expect(orphan).resolves.toEqual({ action: 'decline' })
    expect(ofType(events, 'permission_resolved').at(-1)).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
      message: 'Session closed',
    })
  })

  it('sweeps approvals the turn outlived, and honors serverRequest/resolved', async () => {
    const peer = scriptedPeer()
    const responses: unknown[] = []
    peer.respond('turn/start', () => {
      peer.emit('turn/started', { threadId: 'thread-1', turn: { id: 't1', status: 'inProgress' } })
      // Two asks codex settles without us: one it resolves itself (announced
      // via serverRequest/resolved), one simply outlived by the turn.
      void peer
        .serverRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', itemId: 'c1', command: 'a' }, 'wire-7')
        .then((r) => responses.push(r))
      void peer
        .serverRequest('item/commandExecution/requestApproval', { threadId: 'thread-1', itemId: 'c2', command: 'b' }, 'wire-8')
        .then((r) => responses.push(r))
      return { turn: { id: 't1', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.pendingApprovals).toHaveLength(2))

    // Codex resolved wire-7 on its own (auto-resolution): the card retires.
    peer.emit('serverRequest/resolved', { threadId: 'thread-1', requestId: 'wire-7' })
    expect(runner.pendingApprovals).toHaveLength(1)
    expect(ofType(events, 'permission_resolved')[0]).toMatchObject({
      resolvedBy: 'policy',
      message: 'resolved by codex',
    })

    // The turn ends with the second still pending: swept, never wedged.
    peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't1', status: 'completed' } })
    await run
    expect(runner.pendingApprovals).toHaveLength(0)
    expect(ofType(events, 'permission_resolved')[1]).toMatchObject({
      resolvedBy: 'policy',
      message: 'Turn ended',
    })
    expect(responses).toEqual([{ decision: 'decline' }, { decision: 'decline' }])
    expect(runner.status).toBe('idle')
  })

  it('fails loudly when initialize rejects the experimentalApi capability', async () => {
    const peer = scriptedPeer()
    peer.respond('initialize', () => {
      throw new JsonRpcError(-32602, 'unknown capability: experimentalApi')
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    const [result] = ofType(events, 'turn_result')
    expect(result).toMatchObject({ subtype: 'error_during_execution' })
    expect(result!.errors?.[0]).toMatch(/experimentalApi/)
    expect(result!.errors?.[0]).toMatch(/no non-experimental fallback/)
    // A failed handshake is a failed turn, not a failed session.
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(runner.status).toBe('idle')
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

    // Counted as a DELTA across close(), not as a total: a promptless session
    // also opens a throwaway connection to list skills, and that one closes
    // itself. What matters here is that close() tore down the session's own
    // child exactly once. Snapshot and assert are back to back on purpose —
    // no await between them for the probe's close to slip through.
    const closedBefore = peer.closed()
    runner.close()
    expect(existsSync(image.path!)).toBe(false)
    expect(peer.closed()).toBe(closedBefore + 1)

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
    expect(info.capabilities?.interactiveApprovals).toBe(true)
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

/** Two historical turns whose item ids overlap on purpose: codex restarts item
 * numbering per turn, so the per-turn nonce is what keeps them apart. */
const HISTORY_TURNS = [
  {
    id: 'turn-h1',
    items: [
      {
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'make a file', text_elements: [] }],
      },
      { id: 'item-2', type: 'agentMessage', text: 'Making it.' },
      {
        id: 'item-3',
        type: 'commandExecution',
        command: 'touch x',
        aggregatedOutput: 'ok\n',
        exitCode: 0,
        status: 'completed',
      },
    ],
  },
  {
    id: 'turn-h2',
    items: [
      {
        id: 'item-1',
        type: 'userMessage',
        content: [{ type: 'text', text: 'now delete it', text_elements: [] }],
      },
      { id: 'item-2', type: 'agentMessage', text: 'Deleted.' },
    ],
  },
]

describe('CodexRunner resume backfill', () => {
  it('replays a promptless resume: same item mapping, replay-flagged, one nonce per historical turn', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: HISTORY_TURNS },
      turnsBackwardsCursor: null,
    }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    // The whole history, in order, through the live item mapping.
    const messages = events.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' | 'assistant_message' }> =>
        e.type === 'user_message' || e.type === 'assistant_message',
    )
    const texts = messages.map((e) => {
      const content = e.message.content
      if (typeof content === 'string') return content
      const block = (content as Array<Record<string, unknown>>)[0]!
      return (block.text ?? block.content ?? block.name) as string
    })
    expect(texts).toEqual(['make a file', 'Making it.', 'CodexCommand', 'ok\n', 'now delete it', 'Deleted.'])
    // Every replayed event says so — the reducers key dedupe and styling off it.
    expect(messages.every((e) => e.replay === true)).toBe(true)

    // Ids are namespaced per HISTORICAL turn: both turns carry an `item-1`
    // (codex restarts numbering per turn), and the nonce keeps them apart.
    const uuidOf = (index: number) => messages[index]!.uuid as string
    const nonceOf = (index: number) => uuidOf(index).split(':')[0]!
    expect(uuidOf(0).endsWith(':item-1')).toBe(true)
    expect(uuidOf(4).endsWith(':item-1')).toBe(true)
    expect(uuidOf(0)).not.toBe(uuidOf(4))
    expect(nonceOf(0)).toBe(nonceOf(1)) // one namespace within a turn…
    expect(nonceOf(0)).not.toBe(nonceOf(4)) // …a fresh one for the next

    // The tool card pair agrees with itself.
    const toolUse = messages[2]!.message.content as Array<{ type: string; id: string }>
    const toolResult = messages[3]!.message.content as Array<{ type: string; tool_use_id: string }>
    expect(toolResult[0]!.tool_use_id).toBe(toolUse[0]!.id)

    // History was one page and complete: no thread/read, no turn ran, no notice.
    expect(peer.requests.map((r) => r.method)).toEqual([
      'initialize',
      'thread/resume',
      'skills/list',
    ])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(events.some((e) => e.type === 'turn_result')).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('resume with a prompt: history lands before the new turn, once, with disjoint live ids', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: null,
    }))
    scriptTurn(peer, (emit, turnId) => {
      // The live answer reuses a history item id — the per-turn nonce must
      // keep the transcript bubbles separate anyway (b026e70).
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'item-2', type: 'agentMessage', text: 'Live answer.' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'continue',
      resume: 'prior',
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()

    const messages = events.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' | 'assistant_message' }> =>
        e.type === 'user_message' || e.type === 'assistant_message',
    )
    const texts = messages.map((e) =>
      typeof e.message.content === 'string'
        ? e.message.content
        : ((e.message.content as Array<{ text?: string }>)[0]!.text ?? ''),
    )
    // Replay first, then the new turn's echo, then its answer — never interleaved.
    expect(texts).toEqual(['now delete it', 'Deleted.', 'continue', 'Live answer.'])
    expect(messages.map((e) => e.replay === true)).toEqual([true, true, false, false])
    // One resume, one replay: nothing is emitted twice.
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(1)
    expect(texts.filter((t) => t === 'Deleted.')).toHaveLength(1)
    // Same item id, different namespace.
    expect(messages[1]!.uuid!.endsWith(':item-2')).toBe(true)
    expect(messages[3]!.uuid!.endsWith(':item-2')).toBe(true)
    expect(messages[1]!.uuid).not.toBe(messages[3]!.uuid)
    expect(ofType(events, 'turn_result')[0]).toMatchObject({ subtype: 'success', result: 'Live answer.' })
  })

  it('pages a partial resume through thread/read, so the replay is the whole rollout', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: 'older-turns-exist',
    }))
    peer.respond('thread/read', () => ({ thread: { id: 'thread-1', turns: HISTORY_TURNS } }))
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    expect(peer.requests.map((r) => r.method)).toEqual([
      'initialize',
      'thread/resume',
      'skills/list',
      'thread/read',
    ])
    expect(peer.requests[3]).toMatchObject({
      params: { threadId: 'thread-1', includeTurns: true },
    })
    const users = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(users.map((e) => e.message.content)).toEqual(['make a file', 'now delete it'])
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
  })

  it('says so — visibly — when only a partial page could be loaded', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: 'older-turns-exist',
    }))
    peer.respond('thread/read', () => {
      throw new JsonRpcError(-32601, 'no thread/read here')
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    // The notice precedes the partial replay it qualifies, and the session
    // stays alive and idle — incomplete history is not a failed resume.
    const errorIndex = events.findIndex((e) => e.type === 'session_error')
    const firstReplay = events.findIndex(
      (e) => (e.type === 'user_message' || e.type === 'assistant_message') && e.replay,
    )
    expect(errorIndex).toBeGreaterThanOrEqual(0)
    expect(events[errorIndex]).toMatchObject({
      message: expect.stringContaining('incomplete'),
    })
    expect(firstReplay).toBeGreaterThan(errorIndex)
    const users = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(users.map((e) => e.message.content)).toEqual(['now delete it'])
    expect(runner.status).toBe('idle')
  })

  it('backfillHistory: false keeps the old lazy promptless resume — no child, no replay', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: HISTORY_TURNS },
    }))
    const runner = new CodexRunner({
      cwd: '/tmp',
      resume: 'prior',
      backfillHistory: false,
      connectFn: peer.connectFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(peer.connections()).toBe(0)
    expect(events.some((e) => e.type === 'user_message' || e.type === 'assistant_message')).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('a reconnect after a dead child resumes the thread but never replays twice', async () => {
    const peer = scriptedPeer()
    peer.respond('thread/resume', () => ({
      ...THREAD_RESULT,
      thread: { id: 'thread-1', turns: [HISTORY_TURNS[1]] },
      turnsBackwardsCursor: null,
    }))
    scriptTurn(peer, (emit, turnId) => {
      emit('item/completed', {
        threadId: 'thread-1',
        turnId,
        item: { id: 'a1', type: 'agentMessage', text: 'done' },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', resume: 'prior', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    const replayCount = () =>
      events.filter((e) => (e.type === 'user_message' || e.type === 'assistant_message') && e.replay)
        .length
    expect(replayCount()).toBe(2)

    peer.die('codex app-server exited (code 1): gone')
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(1))
    // The respawned child went through thread/resume again — same responder,
    // same turns on the wire — and none of it was replayed a second time.
    expect(peer.requests.filter((r) => r.method === 'thread/resume')).toHaveLength(2)
    expect(replayCount()).toBe(2)
  })
})
