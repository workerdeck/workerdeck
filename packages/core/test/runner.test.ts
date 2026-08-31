import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@workerdeck/protocol'
import { SessionRunner, type SessionRunnerConfig } from '../src/index.ts'

type HarnessCapabilities = {
  models?: Array<{ value: string; displayName: string; description: string }>
  commands?: Array<{ name: string; description: string; argumentHint: string }>
  contextUsage?: Record<string, unknown>
  usage?: Record<string, unknown>
}

// Controllable stand-in for the SDK: emit SDKMessages, capture options + streamed input.
// Pass `capabilities` to also implement supportedModels/supportedCommands.
function fakeHarness(capabilities?: HarnessCapabilities) {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }
  const interrupt = vi.fn(async () => {})
  const setPermissionMode = vi.fn(async () => {})
  const setModel = vi.fn(async () => {})

  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      messages.push(msg)
    }
  }
  const end = () => {
    done = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: undefined, done: true })
    }
  }

  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const buffered = messages.shift()
      if (buffered !== undefined) {
        return Promise.resolve({ value: buffered, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt,
    setPermissionMode,
    setModel,
    close: end,
    ...(capabilities
      ? {
          supportedModels: vi.fn(async () => capabilities.models ?? []),
          supportedCommands: vi.fn(async () => capabilities.commands ?? []),
        }
      : {}),
    ...(capabilities?.contextUsage ? { getContextUsage: vi.fn(async () => capabilities.contextUsage) } : {}),
    ...(capabilities?.usage
      ? {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => capabilities.usage),
        }
      : {}),
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    void (async () => {
      for await (const input of params.prompt as AsyncIterable<SDKUserMessage>) {
        captured.inputs.push(input)
      }
    })()
    return query
  }

  return { emit, end, captured, interrupt, setPermissionMode, setModel, queryFn }
}

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Bash', 'Read'],
  skills: ['verify-content'],
  slash_commands: ['/verify-content'],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

const assistantMessage = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello from claude' }],
    model: 'claude-test-1',
    stop_reason: 'end_turn',
  },
  parent_tool_use_id: null,
  uuid: 'uuid-a1',
  session_id: 'sdk-session-1',
} as unknown as SDKMessage

const resultMessage = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1200,
  duration_api_ms: 900,
  is_error: false,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'uuid-r1',
  session_id: 'sdk-session-1',
} as unknown as SDKMessage

function makeRunner(overrides: Partial<SessionRunnerConfig> = {}, capabilities?: HarnessCapabilities) {
  const harness = fakeHarness(capabilities)
  const runner = new SessionRunner({
    cwd: '/tmp/project',
    queryFn: harness.queryFn,
    ...overrides,
  })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  return { harness, runner, events }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SessionRunner', () => {
  it('emits system_init, transcript events, and status transitions', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistantMessage)
    harness.emit(resultMessage)
    await tick()

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'status_changed', // idle — no initial prompt, accepting input
      'system_init',
      'status_changed', // running
      'assistant_message',
      'turn_result',
      'status_changed', // idle
    ])
    expect(runner.status).toBe('idle')
    expect(runner.sdkSessionId).toBe('sdk-session-1')
    expect(runner.info().model).toBe('claude-test-1')
    expect(runner.apiKeySource).toBe('user')
    expect(events.every((e, i) => e.seq === i + 1)).toBe(true)
  })

  it('emits user_message events for sent input (the SDK does not echo them)', async () => {
    const { runner, events } = makeRunner({ prompt: 'first' })
    void runner.start()
    runner.sendMessage('second')
    await tick()

    const userEvents = events.filter((e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message')
    expect(userEvents.map((e) => e.message.content)).toEqual(['first', 'second'])
    expect(userEvents.every((e) => typeof e.uuid === 'string' && e.uuid.length > 0)).toBe(true)
    expect(userEvents.every((e) => !e.synthetic && !e.replay)).toBe(true)
  })

  it('sends the initial prompt and queued user messages into the SDK input stream', async () => {
    const { harness, runner } = makeRunner({ prompt: '/verify-content 42' })
    void runner.start()
    runner.sendMessage('follow-up')
    await tick()

    expect(harness.captured.inputs.map((m) => m.message.content)).toEqual(['/verify-content 42', 'follow-up'])
  })

  it('promotes canUseTool into a pending approval and resolves an allow decision', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-1', title: 'Run ls' },
    )
    expect(runner.status).toBe('awaiting_approval')
    const request = runner.pendingApprovals[0]!
    expect(request.toolName).toBe('Bash')
    expect(request.title).toBe('Run ls')

    const ok = runner.resolvePermission(request.id, {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    })
    expect(ok).toBe(true)
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      toolUseID: 'tool-1',
    })
    expect(runner.status).toBe('running')

    const resolved = events.find((e) => e.type === 'permission_resolved')
    expect(resolved).toMatchObject({ requestId: request.id, behavior: 'allow', resolvedBy: 'client' })
  })

  it('allow without updatedInput echoes the original input (SDK requires a record)', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Write',
      { file_path: '/tmp/x.txt', content: 'hi' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-2' },
    )
    await tick()
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/x.txt', content: 'hi' },
      toolUseID: 'tool-2',
    })
  })

  it('denies on timeout by default', async () => {
    const { harness, runner, events } = makeRunner({ approvalTimeoutMs: 20 })
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Write',
      { file_path: '/tmp/x' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-2' },
    )
    const result = await resultPromise
    expect(result?.behavior).toBe('deny')
    const resolved = events.find((e) => e.type === 'permission_resolved')
    expect(resolved).toMatchObject({ behavior: 'deny', resolvedBy: 'timeout' })
    expect(runner.resolvePermission('unknown', { behavior: 'allow' })).toBe(false)
  })

  const questionInput = {
    questions: [
      {
        question: 'Which library should we use?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Zod (Recommended)', description: 'battle-tested' },
          { label: 'Valibot', description: 'smaller bundle' },
        ],
      },
      {
        question: 'Which features do you want?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'Parsing', description: '' },
          { label: 'Codegen', description: '' },
        ],
      },
    ],
  }

  it("questionBehavior 'auto' answers AskUserQuestion with each question's first option", async () => {
    const { harness, runner, events } = makeRunner({ questionBehavior: 'auto' })
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const result = await harness.captured.options!.canUseTool!('AskUserQuestion', questionInput, {
      signal: new AbortController().signal,
      requestId: 'creq-1',
      toolUseID: 'q-1',
    })
    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...questionInput,
        answers: {
          'Which library should we use?': 'Zod (Recommended)',
          'Which features do you want?': 'Parsing',
        },
      },
      toolUseID: 'q-1',
    })
    expect(runner.pendingApprovals).toHaveLength(0)
    expect(runner.status).not.toBe('awaiting_approval')
    expect(events.find((e) => e.type === 'permission_requested')).toMatchObject({
      request: { toolName: 'AskUserQuestion' },
    })
    expect(events.find((e) => e.type === 'permission_resolved')).toMatchObject({
      behavior: 'allow',
      resolvedBy: 'policy',
    })
  })

  it("questionBehavior 'deny' refuses AskUserQuestion but still promotes other tools", async () => {
    const { harness, runner, events } = makeRunner({ questionBehavior: 'deny' })
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const result = await harness.captured.options!.canUseTool!('AskUserQuestion', questionInput, {
      signal: new AbortController().signal,
      requestId: 'creq-1',
      toolUseID: 'q-2',
    })
    expect(result).toMatchObject({ behavior: 'deny', toolUseID: 'q-2' })
    expect((result as { message: string }).message).toMatch(/questions are disabled/)
    expect(events.find((e) => e.type === 'permission_resolved')).toMatchObject({
      behavior: 'deny',
      resolvedBy: 'policy',
    })

    void harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-3' },
    )
    await tick()
    expect(runner.pendingApprovals).toHaveLength(1)
  })

  it("questionBehavior 'ask' (default) leaves AskUserQuestion pending for the client", async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!('AskUserQuestion', questionInput, {
      signal: new AbortController().signal,
      requestId: 'creq-1',
      toolUseID: 'q-3',
    })
    await tick()
    expect(runner.pendingApprovals).toHaveLength(1)

    const answers = { 'Which library should we use?': 'Valibot' }
    runner.resolvePermission(runner.pendingApprovals[0]!.id, {
      behavior: 'allow',
      updatedInput: { ...questionInput, answers },
    })
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { ...questionInput, answers },
      toolUseID: 'q-3',
    })
  })

  it('setModel switches the model and emits model_changed', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    await runner.setModel('claude-opus-4-8')
    expect(harness.setModel).toHaveBeenCalledWith('claude-opus-4-8')
    expect(runner.info().model).toBe('claude-opus-4-8')
    expect(events.at(-1)).toMatchObject({ type: 'model_changed', model: 'claude-opus-4-8' })
  })

  it('setPermissionMode switches the mode and emits permission_mode_changed', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    await runner.setPermissionMode('acceptEdits')
    expect(harness.setPermissionMode).toHaveBeenCalledWith('acceptEdits')
    expect(runner.info().permissionMode).toBe('acceptEdits')
    expect(events.at(-1)).toMatchObject({ type: 'permission_mode_changed', mode: 'acceptEdits' })
  })

  it('polls context usage after each turn and emits context_usage', async () => {
    const { harness, runner, events } = makeRunner(
      {},
      {
        contextUsage: {
          categories: [
            { name: 'System prompt', tokens: 3000, color: '#888', isDeferred: false },
            { name: 'Messages', tokens: 39_000, color: '#0aa' },
          ],
          totalTokens: 42_000,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 21,
          gridRows: [],
          model: 'claude-test-1',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
        },
      },
    )
    void runner.start()
    harness.emit(initMessage)
    harness.emit(resultMessage)
    await tick()
    await tick()

    const usage = events.find((e) => e.type === 'context_usage')
    expect(usage).toMatchObject({
      usage: {
        categories: [
          { name: 'System prompt', tokens: 3000, color: '#888' },
          { name: 'Messages', tokens: 39_000, color: '#0aa' },
        ],
        totalTokens: 42_000,
        maxTokens: 200_000,
        percentage: 21,
        model: 'claude-test-1',
      },
    })
    expect((usage as { usage: Record<string, unknown> }).usage.gridRows).toBeUndefined()
    expect((usage as { usage: { categories: Array<Record<string, unknown>> } }).usage.categories[0]!.isDeferred).toBeUndefined()
  })

  it('promotes rate_limit_event messages to first-class rate_limit events', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 30,
        resetsAt: 1_800_000_000,
        isUsingOverage: false,
        overageStatus: 'allowed',
      },
      uuid: 'uuid-rl1',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    await tick()

    const rateLimit = events.find((e) => e.type === 'rate_limit')
    expect(rateLimit).toMatchObject({
      info: {
        status: 'allowed',
        rateLimitType: 'five_hour',
        utilization: 30,
        resetsAt: 1_800_000_000,
        isUsingOverage: false,
      },
    })
    expect((rateLimit as { info: Record<string, unknown> }).info.overageStatus).toBeUndefined()
    expect(events.some((e) => e.type === 'sdk_event')).toBe(false)
  })

  it('polls the plan usage, naming the plan once and re-reporting the windows', async () => {
    const { harness, runner, events } = makeRunner(
      {},
      {
        usage: {
          subscription_type: 'max',
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 6, resets_at: '2026-08-05T11:00:00Z' } },
        },
      },
    )
    void runner.start()
    harness.emit(initMessage)
    harness.emit(resultMessage)
    await tick()
    harness.emit(resultMessage)
    await tick()

    expect(events.filter((e) => e.type === 'plan_info')).toEqual([expect.objectContaining({ type: 'plan_info', subscriptionType: 'max' })])
    expect(events.filter((e) => e.type === 'rate_limit').length).toBeGreaterThan(1)
    expect(events.find((e) => e.type === 'rate_limit')).toMatchObject({
      info: { rateLimitType: 'five_hour', utilization: 6, status: 'allowed' },
    })
  })

  it('emits capabilities after init when the query reports models/commands', async () => {
    const { harness, runner, events } = makeRunner(
      { prompt: 'hi' },
      {
        models: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Most capable' }],
        commands: [{ name: 'compact', description: 'Compact the conversation', argumentHint: '' }],
      },
    )
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const capabilities = events.find((e) => e.type === 'capabilities')
    expect(capabilities).toMatchObject({
      models: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }],
      commands: [{ name: 'compact' }],
    })
  })

  it('fetches capabilities eagerly for promptless sessions, emitting only once', async () => {
    const { harness, runner, events } = makeRunner(
      {},
      {
        models: [{ value: 'default', displayName: 'Default (recommended)', description: 'Opus' }],
        commands: [{ name: 'compact', description: '', argumentHint: '' }],
      },
    )
    void runner.start()
    await tick()

    expect(events.some((e) => e.type === 'capabilities')).toBe(true)
    expect(events.some((e) => e.type === 'system_init')).toBe(false)

    harness.emit(initMessage)
    await tick()
    expect(events.filter((e) => e.type === 'capabilities')).toHaveLength(1)
  })

  it('replays events from a given seq on subscribe', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistantMessage)
    await tick()

    const replayed: SessionEvent[] = []
    runner.subscribe((e) => replayed.push(e), 3)
    expect(replayed.map((e) => e.seq)).toEqual([4])

    harness.emit(resultMessage)
    await tick()
    expect(replayed.map((e) => e.type)).toEqual(['assistant_message', 'turn_result', 'status_changed'])
  })

  it('a coalesced replay drops the stream deltas the reducer discards', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const partial = (delta: Record<string, unknown>) =>
      ({
        type: 'stream_event',
        uuid: 'u',
        session_id: 's',
        parent_tool_use_id: null,
        event: delta,
      }) as never
    harness.emit(partial({ type: 'message_start' }))
    harness.emit(partial({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }))
    harness.emit(partial({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"a":1}' } }))
    harness.emit(partial({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }))
    harness.emit(partial({ type: 'content_block_stop' }))
    harness.emit(assistantMessage)
    await tick()

    const full: SessionEvent[] = []
    runner.subscribe((e) => full.push(e))
    const thin: SessionEvent[] = []
    runner.subscribe((e) => thin.push(e), 0, { coalesceReplay: true })

    const deltas = (list: SessionEvent[]) => list.filter((e) => e.type === 'stream_delta')
    expect(deltas(full)).toHaveLength(5)
    expect(deltas(thin)).toHaveLength(2)
    expect(thin.at(-1)?.seq).toBe(full.at(-1)?.seq)
  })

  it('close() denies pending approvals, closes the query, and goes terminal', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'rm -rf /' },
      { signal: new AbortController().signal, requestId: 'creq-1', toolUseID: 'tool-3' },
    )
    runner.close()
    const result = await resultPromise
    expect(result?.behavior).toBe('deny')
    expect(runner.status).toBe('closed')
    expect(events.at(-1)!.type).toBe('status_changed')
    expect(events.some((e) => e.type === 'session_closed')).toBe(true)
    expect(() => runner.sendMessage('nope')).toThrow()
  })

  it('surfaces query failures as session_error + failed status', async () => {
    const runner = new SessionRunner({
      cwd: '/tmp/project',
      queryFn: () => {
        throw new Error('spawn failed')
      },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    await runner.start()
    expect(events.some((e) => e.type === 'session_error')).toBe(true)
    expect(runner.status).toBe('failed')
  })

  it('tracks cost/turn rollups and title on info()', async () => {
    const { harness, runner } = makeRunner({ prompt: 'do the thing' })
    void runner.start()
    harness.emit(initMessage)
    harness.emit(resultMessage)
    await tick()

    const info = runner.info()
    expect(info.title).toBe('do the thing')
    expect(info.totalCostUsd).toBe(0.01)
    expect(info.numTurns).toBe(1)
    expect(info.lastActivityAt).toBeGreaterThan(0)

    const { runner: named } = makeRunner({ prompt: 'p', meta: { title: 'My session' } })
    expect(named.info().title).toBe('My session')
  })

  describe("the CLI's own session title", () => {
    const sessionInfo = (info: Record<string, unknown>) =>
      vi.fn(async () => ({ sessionId: 'sdk-session-1', lastModified: 0, ...info }) as never)

    it('adopts the generated summary, and prefers a /rename over it', async () => {
      const sessionInfoFn = sessionInfo({
        summary: 'Fixing the scrubber lane',
        firstPrompt: 'the right lane mark never grows, have a look',
      })
      const { harness, runner } = makeRunner({
        prompt: 'the right lane mark never grows, have a look',
        sessionInfoFn,
      })
      void runner.start()
      harness.emit(initMessage)
      await tick()
      expect(runner.info().title).toBe('Fixing the scrubber lane')
      expect(sessionInfoFn).toHaveBeenCalledWith('sdk-session-1', { dir: '/tmp/project' })

      const renamed = makeRunner({
        prompt: 'p',
        sessionInfoFn: sessionInfo({ summary: 'Generated', customTitle: 'What I called it' }),
      })
      void renamed.runner.start()
      renamed.harness.emit(initMessage)
      await tick()
      expect(renamed.runner.info().title).toBe('What I called it')
    })

    it('leaves a summary that is just the first prompt to the prompt fallback', async () => {
      const { harness, runner } = makeRunner({
        prompt: 'do the thing',
        sessionInfoFn: sessionInfo({ summary: 'do the thing', firstPrompt: 'do the thing' }),
      })
      void runner.start()
      harness.emit(initMessage)
      await tick()
      expect(runner.info().title).toBe('do the thing')
    })

    it('never reads it while the host has named the session', async () => {
      const sessionInfoFn = sessionInfo({ summary: 'Generated', firstPrompt: 'p' })
      const { harness, runner } = makeRunner({
        prompt: 'p',
        meta: { title: 'My session' },
        sessionInfoFn,
      })
      void runner.start()
      harness.emit(initMessage)
      harness.emit(resultMessage)
      await tick()
      expect(sessionInfoFn).not.toHaveBeenCalled()
      expect(runner.info().title).toBe('My session')

      runner.setTitle(undefined)
      harness.emit(resultMessage)
      await tick()
      expect(runner.info().title).toBe('Generated')
    })
  })

  it('backfills resumed-session history as replay events before live events', async () => {
    const history = [
      {
        type: 'user' as const,
        uuid: 'uuid-h1',
        session_id: 'sdk-session-1',
        message: { role: 'user', content: 'earlier prompt' },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'uuid-h2',
        session_id: 'sdk-session-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'system' as const,
        uuid: 'uuid-h3',
        session_id: 'sdk-session-1',
        message: {},
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]
    const historyFn = vi.fn(async () => history)
    const { harness, runner, events } = makeRunner({ resume: 'sdk-session-1', historyFn })
    void runner.start()
    await tick()
    harness.emit(initMessage)
    await tick()

    expect(historyFn).toHaveBeenCalledWith('sdk-session-1', { dir: '/tmp/project' })
    const types = events.map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['user_message', 'assistant_message'])
    expect(types).toContain('system_init')
    const replayUser = events[0] as Extract<SessionEvent, { type: 'user_message' }>
    expect(replayUser.replay).toBe(true)
    expect(replayUser.uuid).toBe('uuid-h1')
    const replayAssistant = events[1] as Extract<SessionEvent, { type: 'assistant_message' }>
    expect(replayAssistant.replay).toBe(true)
    expect(events).toHaveLength(events.filter((e) => e.type !== 'sdk_event').length)
  })

  it("stamps the harness's own wrapper messages synthetic on backfill", async () => {
    const entry = (uuid: string, content: unknown) => ({
      type: 'user' as const,
      uuid,
      session_id: 'sdk-session-1',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      parent_agent_id: null,
    })
    const history = [
      entry('h-task', '<task-notification>\n<task-id>abc</task-id>\n</task-notification>'),
      entry('h-caveat', '<local-command-caveat>Caveat: the messages below…</local-command-caveat>'),
      // Not synthetic: rendered as the command line a person ran.
      entry('h-command', '<command-name>/wrapup</command-name><command-args>ship it</command-args>'),
      // Not synthetic either: rendered as a notice row.
      entry('h-stdout', '<local-command-stdout>Set model to Fable 5</local-command-stdout>'),
      entry('h-typed', [{ type: 'text', text: 'a real prompt' }]),
    ]
    const { harness, runner, events } = makeRunner({
      resume: 'sdk-session-1',
      historyFn: vi.fn(async () => history),
    })
    void runner.start()
    await tick()
    harness.emit(initMessage)
    await tick()

    const byUuid = new Map(
      events
        .filter((e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message')
        .map((e) => [e.uuid, e.synthetic]),
    )
    expect(byUuid.get('h-task')).toBe(true)
    expect(byUuid.get('h-caveat')).toBe(true)
    expect(byUuid.get('h-command')).toBeUndefined()
    expect(byUuid.get('h-stdout')).toBeUndefined()
    expect(byUuid.get('h-typed')).toBeUndefined()
  })

  it('resume without history and historyFn failures are non-fatal', async () => {
    const historyFn = vi.fn(async () => {
      throw new Error('no transcript')
    })
    const { harness, runner, events } = makeRunner({ resume: 'sdk-session-x', historyFn })
    void runner.start()
    await tick()
    harness.emit(initMessage)
    await tick()
    expect(events.map((e) => e.type)).toContain('system_init')
    expect(runner.status).toBe('running')
  })

  describe('conversation_reset (/clear, plan-mode exit)', () => {
    const resetMessage = {
      type: 'conversation_reset',
      new_conversation_id: 'sdk-session-2',
      uuid: 'uuid-reset',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage

    it('emits the event, adopts the new conversation id, and keeps activityCount monotonic', async () => {
      const { harness, runner, events } = makeRunner()
      void runner.start()
      harness.emit(initMessage)
      harness.emit(assistantMessage)
      harness.emit(resultMessage)
      await tick()
      const activityBefore = runner.info().activityCount

      harness.emit(resetMessage)
      await tick()

      const reset = events.find((e): e is Extract<SessionEvent, { type: 'conversation_reset' }> => e.type === 'conversation_reset')
      expect(reset?.sdkSessionId).toBe('sdk-session-2')
      expect(runner.sdkSessionId).toBe('sdk-session-2')
      expect(runner.info().activityCount).toBe(activityBefore)
    })

    it('replays no pre-reset content to a fresh attach, but every state-bearing event', async () => {
      const { harness, runner } = makeRunner({}, { models: [{ value: 'opus', displayName: 'Opus', description: '' }], commands: [] })
      void runner.start()
      await tick() // promptless: capabilities fetched eagerly
      harness.emit(initMessage)
      harness.emit(assistantMessage)
      harness.emit(resultMessage)
      harness.emit(resetMessage)
      harness.emit({ ...assistantMessage, uuid: 'uuid-a2' } as unknown as SDKMessage)
      await tick()

      const replayed: SessionEvent[] = []
      runner.subscribe((e) => replayed.push(e))
      const types = replayed.map((e) => e.type)
      expect(types.filter((t) => t === 'assistant_message')).toHaveLength(1)
      expect(types).not.toContain('turn_result')
      expect(types).toContain('system_init')
      expect(types).toContain('capabilities')
      expect(types).toContain('status_changed')
      expect(types).toContain('conversation_reset')
      const assistant = replayed.find((e): e is Extract<SessionEvent, { type: 'assistant_message' }> => e.type === 'assistant_message')
      expect(assistant?.uuid).toBe('uuid-a2')
    })

    it('still replays the reset to a reconnecting client holding pre-reset rows', async () => {
      const { harness, runner } = makeRunner()
      void runner.start()
      harness.emit(initMessage)
      harness.emit(assistantMessage)
      await tick()
      const detachedAt = runner.lastSeq // client saw the assistant row, then dropped

      harness.emit(resetMessage)
      await tick()

      const replayed: SessionEvent[] = []
      runner.subscribe((e) => replayed.push(e), detachedAt)
      expect(replayed.map((e) => e.type)).toContain('conversation_reset')
    })

    it('a second reset supersedes the first: only the latest replays, with only its aftermath', async () => {
      const { harness, runner } = makeRunner()
      void runner.start()
      harness.emit(initMessage)
      harness.emit(assistantMessage)
      harness.emit(resetMessage)
      harness.emit({ ...assistantMessage, uuid: 'uuid-between' } as unknown as SDKMessage)
      harness.emit({
        ...resetMessage,
        new_conversation_id: 'sdk-session-3',
        uuid: 'uuid-reset-2',
      } as unknown as SDKMessage)
      harness.emit({ ...assistantMessage, uuid: 'uuid-after' } as unknown as SDKMessage)
      await tick()

      const replayed: SessionEvent[] = []
      runner.subscribe((e) => replayed.push(e))
      const resets = replayed.filter((e): e is Extract<SessionEvent, { type: 'conversation_reset' }> => e.type === 'conversation_reset')
      expect(resets).toHaveLength(1)
      expect(resets[0]!.sdkSessionId).toBe('sdk-session-3')
      const assistants = replayed.filter((e): e is Extract<SessionEvent, { type: 'assistant_message' }> => e.type === 'assistant_message')
      expect(assistants.map((e) => e.uuid)).toEqual(['uuid-after'])
      expect(runner.sdkSessionId).toBe('sdk-session-3')
    })
  })
})

describe('status after a turn ends under a standing approval', () => {
  const askApproval = (harness: ReturnType<typeof makeRunner>['harness'], id: string): void =>
    void harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, requestId: id, toolUseID: `tool-${id}` },
    )

  const stateChanged = (state: 'idle' | 'running') => ({ type: 'system', subtype: 'session_state_changed', state }) as unknown as SDKMessage

  it('settles to idle when turn_result arrived while the approval was pending', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    askApproval(harness, 'creq-a')
    expect(runner.status).toBe('awaiting_approval')

    // The turn ends while the approval stands — what an interrupt does.
    harness.emit(resultMessage)
    await tick()
    expect(runner.status).toBe('awaiting_approval')

    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'deny', message: 'no' })
    await tick()
    expect(runner.status).toBe('idle')
  })

  it('settles to idle when the SDK reported idle while the approval was pending', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    askApproval(harness, 'creq-b')
    harness.emit(stateChanged('idle'))
    await tick()
    expect(runner.status).toBe('awaiting_approval')

    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await tick()
    expect(runner.status).toBe('idle')
  })

  it('still resumes to running when the turn did not end — the common case', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    askApproval(harness, 'creq-c')
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await tick()
    expect(runner.status).toBe('running')
  })

  it('does not let a stale turn-over settle a NEW turn as idle', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    askApproval(harness, 'creq-d')
    harness.emit(resultMessage)
    await tick()
    // Work resumes before the approval is answered: the recorded turn-over belongs to a turn
    // that is gone.
    harness.emit(stateChanged('running'))
    await tick()

    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await tick()
    expect(runner.status).toBe('running')
  })
})
