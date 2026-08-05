import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { ENGINE_CAPABILITIES, type SessionEvent } from '@workerdeck/protocol'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import type {
  CodexFactory,
  CodexOptionsLike,
  CodexThreadEvent,
  CodexThreadOptions,
  CodexUsage,
  CodexUserInput,
} from '../src/engines/codex/types.ts'

const USAGE: CodexUsage = {
  input_tokens: 1000,
  cached_input_tokens: 800,
  cache_write_input_tokens: 50,
  output_tokens: 100,
  reasoning_output_tokens: 25,
}

type ScriptedTurn = {
  events: CodexThreadEvent[]
  /** After the events, wait for abort and then throw like a killed child. */
  hang?: boolean
  /** Throw instead of yielding anything (a spawn that dies). */
  throwError?: string
}

/** The `queryFn` pattern for codex: a scripted exec, no binary spawn. */
function scriptedCodex(turns: ScriptedTurn[]) {
  const calls: Array<{
    input: string | CodexUserInput[]
    threadOptions: CodexThreadOptions | undefined
    resumedFrom: string | undefined
  }> = []
  const factoryOptions: CodexOptionsLike[] = []
  let turnIndex = 0
  const codexFn: CodexFactory = (options) => {
    factoryOptions.push(options)
    const thread = (resumedFrom: string | undefined, threadOptions?: CodexThreadOptions) => ({
      runStreamed: async (input: string | CodexUserInput[], turnOptions?: { signal?: AbortSignal }) => {
        calls.push({ input, threadOptions, resumedFrom })
        const turn = turns[turnIndex++] ?? { events: [] }
        return {
          events: (async function* () {
            if (turn.throwError) throw new Error(turn.throwError)
            for (const event of turn.events) yield event
            if (turn.hang) {
              await new Promise<never>((_, reject) => {
                const signal = turnOptions?.signal
                if (signal?.aborted) reject(new Error('Codex exited with code 130'))
                signal?.addEventListener('abort', () =>
                  reject(new Error('Codex exited with code 130')),
                )
              })
            }
          })(),
        }
      },
    })
    return {
      startThread: (options?: CodexThreadOptions) => thread(undefined, options),
      resumeThread: (id: string, options?: CodexThreadOptions) => thread(id, options),
    }
  }
  return { codexFn, calls, factoryOptions }
}

function collect(runner: CodexRunner): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  return events
}

/** Type-narrowing filter (Array.filter alone doesn't narrow union members). */
function ofType<T extends SessionEvent['type']>(
  events: SessionEvent[],
  type: T,
): Array<Extract<SessionEvent, { type: T }>> {
  return events.filter((e): e is Extract<SessionEvent, { type: T }> => e.type === type)
}

const item = (event: 'item.started' | 'item.updated' | 'item.completed', payload: object) =>
  ({ type: event, item: payload }) as CodexThreadEvent

describe('CodexRunner event mapping', () => {
  it('folds the full item vocabulary into protocol events (§9.2)', async () => {
    const { codexFn } = scriptedCodex([
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-1' },
          { type: 'turn.started' },
          item('item.started', { id: 'r1', type: 'reasoning', text: '' }),
          item('item.updated', { id: 'r1', type: 'reasoning', text: 'thinking…' }),
          item('item.completed', { id: 'r1', type: 'reasoning', text: 'thinking…' }),
          item('item.started', { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' }),
          item('item.completed', { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: 'file.txt\n', exit_code: 0, status: 'completed' }),
          item('item.completed', { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }], status: 'completed' }),
          item('item.started', { id: 'm1', type: 'mcp_tool_call', server: 'wiki', tool: 'lookup', arguments: { q: 'x' }, status: 'in_progress' }),
          item('item.completed', { id: 'm1', type: 'mcp_tool_call', server: 'wiki', tool: 'lookup', arguments: { q: 'x' }, result: { ok: true }, status: 'completed' }),
          item('item.completed', { id: 'w1', type: 'web_search', query: 'weather' }),
          item('item.completed', { id: 't1', type: 'todo_list', items: [{ text: 'step', completed: false }] }),
          item('item.completed', { id: 'e1', type: 'error', message: 'transport hiccup' }),
          item('item.completed', { id: 'x1', type: 'exotic_novelty', detail: 42 }),
          item('item.started', { id: 'a1', type: 'agent_message', text: 'Hel' }),
          item('item.updated', { id: 'a1', type: 'agent_message', text: 'Hello' }),
          item('item.completed', { id: 'a1', type: 'agent_message', text: 'Hello' }),
          { type: 'turn.completed', usage: USAGE },
        ],
      },
    ])
    const runner = new CodexRunner({ cwd: '/tmp/p', prompt: 'go', codexFn })
    const events = collect(runner)
    await runner.start()

    // Thread id becomes the resumable session id.
    expect(runner.sdkSessionId).toBe('thread-1')

    const types = events.map((e) => e.type)
    // The record's forsworn events never occur — conformance over a
    // full-vocabulary run.
    for (const forsworn of ['system_init', 'permission_requested', 'context_usage', 'rate_limit', 'plan_info', 'capabilities']) {
      expect(types).not.toContain(forsworn)
    }

    // Reasoning lands as its own thinking message before the text answer.
    const assistants = ofType(events, 'assistant_message')
    expect(assistants[0]!.message.content).toEqual([{ type: 'thinking', thinking: 'thinking…' }])

    // Command execution: tool_use at start, paired tool_result at completion.
    // Published ids are per-turn-namespaced (codex restarts item ids in every
    // exec child), with the raw id surviving as the suffix.
    const commandUse = assistants.find(
      (e) => Array.isArray(e.message.content) && e.message.content[0]!.type === 'tool_use'
        && (e.message.content[0] as { name?: string }).name === 'CodexCommand',
    )!
    const commandBlock = (commandUse.message.content as Array<{ id: string }>)[0]!
    expect(commandBlock).toMatchObject({
      type: 'tool_use',
      name: 'CodexCommand',
      input: { command: 'ls' },
    })
    expect(commandBlock.id).toMatch(/:c1$/)
    const results = ofType(events, 'user_message').filter((e) => e.synthetic)
    const commandResult = results.find(
      (e) => (e.message.content as Array<{ tool_use_id?: string }>)[0]!.tool_use_id === commandBlock.id,
    )!
    expect((commandResult.message.content as Array<{ content?: string; is_error?: boolean }>)[0]).toMatchObject({
      content: 'file.txt\n',
    })

    // File changes arrive post-hoc: use + result together, matching ids.
    const fileUse = assistants.find(
      (e) => Array.isArray(e.message.content)
        && (e.message.content[0] as { name?: string }).name === 'CodexFileChange',
    )!
    expect((fileUse.message.content as Array<{ id?: string }>)[0]!.id).toMatch(/:f1$/)

    // MCP calls take Claude's naming so existing MCP-aware rendering applies.
    const mcpUse = assistants.find(
      (e) => Array.isArray(e.message.content)
        && (e.message.content[0] as { name?: string }).name === 'mcp__wiki__lookup',
    )
    expect(mcpUse).toBeDefined()

    // Unmodeled codex items ride sdk_event, namespaced.
    const sdkTypes = ofType(events, 'sdk_event').map((e) => e.payload.type)
    expect(sdkTypes).toContain('codex.todo_list')
    expect(sdkTypes).toContain('codex.error')
    expect(sdkTypes).toContain('codex.exotic_novelty')

    // The turn result: final text, success, and the usage normalization of
    // §9.5 — Anthropic convention, input excludes cache, reasoning is output.
    const result = ofType(events, 'turn_result')[0]!
    expect(result).toMatchObject({
      subtype: 'success',
      isError: false,
      result: 'Hello',
      numTurns: 1,
      totalCostUsd: 0,
      usage: {
        input_tokens: 200,
        output_tokens: 125,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 800,
      },
    })
    expect(runner.status).toBe('idle')
  })

  it('synthesizes stream deltas from item text growth, suppressible', async () => {
    const script = [
      {
        events: [
          { type: 'thread.started', thread_id: 't' } as CodexThreadEvent,
          item('item.started', { id: 'a', type: 'agent_message', text: 'He' }),
          item('item.updated', { id: 'a', type: 'agent_message', text: 'Hello' }),
          item('item.completed', { id: 'a', type: 'agent_message', text: 'Hello' }),
          { type: 'turn.completed', usage: USAGE } as CodexThreadEvent,
        ],
      },
    ]
    const on = scriptedCodex(script)
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', codexFn: on.codexFn })
    const events = collect(runner)
    await runner.start()
    const deltas = ofType(events, 'stream_delta')
    expect(deltas.map((d) => (d.event.delta as { text: string }).text)).toEqual(['He', 'llo'])

    const off = scriptedCodex(script)
    const quiet = new CodexRunner({ cwd: '/tmp', prompt: 'hi', includePartialMessages: false, codexFn: off.codexFn })
    const quietEvents = collect(quiet)
    await quiet.start()
    expect(quietEvents.some((e) => e.type === 'stream_delta')).toBe(false)
  })

  it('treats a failed turn as a failed turn, not a failed session', async () => {
    const { codexFn } = scriptedCodex([
      {
        events: [
          { type: 'thread.started', thread_id: 't' },
          { type: 'error', message: 'Reconnecting... 1/5' },
          { type: 'turn.failed', error: { message: '401 Unauthorized' } },
        ],
      },
      {
        events: [
          item('item.completed', { id: 'a', type: 'agent_message', text: 'recovered' }),
          { type: 'turn.completed', usage: USAGE },
        ],
      },
    ])
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', codexFn })
    const events = collect(runner)
    await runner.start()
    const failed = ofType(events, 'turn_result')[0]!
    expect(failed).toMatchObject({
      subtype: 'error_during_execution',
      isError: true,
      errors: ['401 Unauthorized'],
    })
    expect(runner.status).toBe('idle')
    expect(events.some((e) => e.type === 'session_error')).toBe(false)

    // The session stays usable: the next message runs an ordinary turn.
    runner.sendMessage('again')
    await vi.waitFor(() => {
      const results = ofType(events, 'turn_result')
      expect(results).toHaveLength(2)
      expect(results[1]).toMatchObject({ subtype: 'success', result: 'recovered' })
    })
  })

  it('interrupt kills the child and lands as an interrupted turn result', async () => {
    const { codexFn } = scriptedCodex([
      { events: [{ type: 'thread.started', thread_id: 't' }], hang: true },
    ])
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'spin', codexFn })
    const events = collect(runner)
    const run = runner.start()
    await vi.waitFor(() => expect(runner.status).toBe('running'))
    await runner.interrupt()
    await run
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['interrupted'],
    })
    expect(runner.status).toBe('idle')
  })

  it('queues messages: one turn at a time, in order', async () => {
    const answer = (text: string, id: string): ScriptedTurn => ({
      events: [
        { type: 'thread.started', thread_id: 't' },
        item('item.completed', { id, type: 'agent_message', text }),
        { type: 'turn.completed', usage: USAGE },
      ],
    })
    const { codexFn, calls } = scriptedCodex([answer('one', 'a1'), answer('two', 'a2')])
    const runner = new CodexRunner({ cwd: '/tmp', codexFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('first')
    runner.sendMessage('second')
    await vi.waitFor(() => {
      expect(ofType(events, 'turn_result')).toHaveLength(2)
    })
    expect(calls.map((c) => c.input)).toEqual(['first', 'second'])
    expect(ofType(events, 'turn_result').map((e) => e.result)).toEqual([
      'one',
      'two',
    ])
  })

  it('namespaces item ids per turn — two exec children never publish the same id', async () => {
    // One codex child per turn, and item ids restart at item_0 in every child.
    // Raw ids on the wire would make a client's upsert-by-id overwrite turn 1's
    // bubble with turn N's answer (the reproduced "codex returned nothing" bug).
    const turn = (text: string): ScriptedTurn => ({
      events: [
        { type: 'thread.started', thread_id: 't' },
        item('item.started', { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' }),
        item('item.completed', { id: 'item_0', type: 'command_execution', command: 'ls', aggregated_output: 'ok\n', exit_code: 0, status: 'completed' }),
        item('item.completed', { id: 'item_1', type: 'agent_message', text }),
        { type: 'turn.completed', usage: USAGE },
      ],
    })
    const { codexFn } = scriptedCodex([turn('four'), turn('six')])
    const runner = new CodexRunner({ cwd: '/tmp', codexFn })
    const events = collect(runner)
    void runner.start()
    runner.sendMessage('2+2')
    runner.sendMessage('3+3')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))

    // Both answers survive as distinct items: distinct uuids, stable raw suffix.
    const answers = ofType(events, 'assistant_message').filter(
      (e) => Array.isArray(e.message.content) && e.message.content[0]!.type === 'text',
    )
    expect(answers.map((e) => (e.message.content as Array<{ text: string }>)[0]!.text)).toEqual([
      'four',
      'six',
    ])
    expect(answers[0]!.uuid).not.toBe(answers[1]!.uuid)
    for (const answer of answers) expect(answer.uuid).toMatch(/:item_1$/)

    // Tool ids: distinct across turns, and each turn's tool_result pairs with
    // its own turn's tool_use (started → completed stays one item).
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

  it('applies model/mode/effort per spawn, mutable between turns, fixed mid-turn', async () => {
    const done = (id: string): ScriptedTurn => ({
      events: [
        { type: 'thread.started', thread_id: 'thread-9' },
        item('item.completed', { id, type: 'agent_message', text: 'ok' }),
        { type: 'turn.completed', usage: USAGE },
      ],
    })
    const { codexFn, calls } = scriptedCodex([done('a'), done('b'), { events: [], hang: true }])
    const runner = new CodexRunner({
      cwd: '/tmp/project',
      prompt: 'go',
      model: 'gpt-5.6-sol',
      permissionMode: 'acceptEdits',
      reasoningEffort: 'ultra',
      codexFn,
    })
    const events = collect(runner)
    await runner.start()
    expect(calls[0]!.resumedFrom).toBeUndefined()
    expect(calls[0]!.threadOptions).toEqual({
      model: 'gpt-5.6-sol',
      sandboxMode: 'workspace-write',
      workingDirectory: '/tmp/project',
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      modelReasoningEffort: 'ultra',
    })

    await runner.setModel('gpt-5.5')
    await runner.setPermissionMode('bypassPermissions')
    expect(events.some((e) => e.type === 'model_changed' && e.model === 'gpt-5.5')).toBe(true)
    runner.sendMessage('next')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    // The follow-up turn resumes the thread the first spawn started.
    expect(calls[1]!.resumedFrom).toBe('thread-9')
    expect(calls[1]!.threadOptions).toMatchObject({
      model: 'gpt-5.5',
      sandboxMode: 'danger-full-access',
    })

    // Mid-turn, the running child's settings are fixed.
    runner.sendMessage('spin')
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    await expect(runner.setModel('gpt-5.2')).rejects.toThrow(/mid-turn/)
    await expect(runner.setPermissionMode('default')).rejects.toThrow(/mid-turn/)
    runner.close()
  })

  it("maps 'default' to the read-only sandbox — the honest degradation", async () => {
    const { codexFn, calls } = scriptedCodex([
      { events: [{ type: 'turn.completed', usage: USAGE }] },
    ])
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'x', codexFn })
    await runner.start()
    expect(calls[0]!.threadOptions?.sandboxMode).toBe('read-only')
    expect(calls[0]!.threadOptions?.approvalPolicy).toBe('never')
  })

  it('resumes an existing thread id from the create request', async () => {
    const { codexFn, calls } = scriptedCodex([
      { events: [{ type: 'turn.completed', usage: USAGE }] },
    ])
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'continue', resume: 'prior-thread', codexFn })
    await runner.start()
    expect(calls[0]!.resumedFrom).toBe('prior-thread')
  })

  it('refuses forkSession and CLI-only permission modes at construction', () => {
    const { codexFn } = scriptedCodex([])
    expect(
      () => new CodexRunner({ cwd: '/tmp', resume: 't', forkSession: true, codexFn }),
    ).toThrow(/fork/)
    expect(() => new CodexRunner({ cwd: '/tmp', permissionMode: 'plan', codexFn })).toThrow(
      /not supported/,
    )
  })

  it('hands images to codex as temp files and cleans them up on close', async () => {
    const { codexFn, calls } = scriptedCodex([
      { events: [{ type: 'turn.completed', usage: USAGE }] },
    ])
    const runner = new CodexRunner({ cwd: '/tmp', codexFn })
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
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    const input = calls[0]!.input as CodexUserInput[]
    const image = input.find((p) => p.type === 'local_image')!
    expect(image.path).toMatch(/att-1\.png$/)
    expect(existsSync(image.path)).toBe(true)
    expect(readFileSync(image.path).equals(Buffer.from(pixel, 'base64'))).toBe(true)
    // Text files inline in the shared envelope; the typed text follows.
    const texts = input.filter((p) => p.type === 'text').map((p) => p.text)
    expect(texts[0]).toContain('<attachment name="notes.txt" type="text/plain">')
    expect(texts[0]).toContain('hello')
    expect(texts[1]).toBe('what is this?')

    runner.close()
    expect(existsSync(image.path)).toBe(false)
  })

  it('refuses a PDF attachment — no codex representation exists', async () => {
    const { codexFn } = scriptedCodex([])
    const runner = new CodexRunner({ cwd: '/tmp', codexFn })
    void runner.start()
    expect(() =>
      runner.sendMessage('read this', [
        { id: 'a', name: 'doc.pdf', mediaType: 'application/pdf', bytes: 4, data: 'JVBERg==' },
      ]),
    ).toThrow(/unsupported attachment/)
    // What `#buildInput` accepts (images as paths, text inlined) is exactly what
    // the record promises — clients filter their attach menus by this list.
    expect(ENGINE_CAPABILITIES.codex.attachments).toEqual(['image', 'text'])
  })

  it('passes a complete child env with the CODEX_HOME pin winning', () => {
    const { codexFn, factoryOptions } = scriptedCodex([])
    new CodexRunner({
      cwd: '/tmp',
      codexFn,
      env: { PATH: '/usr/bin', HOME: '/Users/op', CODEX_HOME: '/elsewhere', GONE: undefined },
      codexHome: '/profiles/codex-a',
    })
    expect(factoryOptions[0]!.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/op',
      CODEX_HOME: '/profiles/codex-a',
    })
  })

  it('reports codex identity, capabilities, and thread id on info()', async () => {
    const { codexFn } = scriptedCodex([
      {
        events: [
          { type: 'thread.started', thread_id: 'thread-5' },
          { type: 'turn.completed', usage: USAGE },
        ],
      },
    ])
    const runner = new CodexRunner({ cwd: '/tmp/w', prompt: 'hello world', codexFn })
    await runner.start()
    const info = runner.info()
    expect(info.engine).toBe('codex')
    expect(info.capabilities?.interactiveApprovals).toBe(false)
    expect(info.capabilities?.streaming).toBe('item')
    expect(info.sdkSessionId).toBe('thread-5')
    expect(info.canBypassPermissions).toBe(true)
    expect(info.pendingPermissionCount).toBe(0)
    expect(info.title).toBe('hello world')
  })

  it('survives a stream that dies without a terminal event', async () => {
    const { codexFn } = scriptedCodex([{ events: [], throwError: 'spawn ENOENT' }])
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'x', codexFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['spawn ENOENT'],
    })
    expect(runner.status).toBe('idle')
  })
})
