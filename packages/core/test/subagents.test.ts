import { describe, expect, it } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { SUBAGENT_HISTORY } from '@workerdeck/protocol'
import { SessionRunner, type SessionRunnerConfig } from '../src/index.ts'

/**
 * The sub-agent rollup (`SessionInfo.subagents`) — what a sessions list, which
 * never attaches, can know about the agents running inside a session. Driven
 * through the runner rather than the tracker directly, because the claim under
 * test is that the one `#emit` chokepoint (live stream *and* resume backfill)
 * is enough to derive it: no event was added to the protocol for this.
 */

/** Minimal stand-in for the SDK: emit SDKMessages, capture options + streamed
 * input (same shape as runner.test.ts's harness, without the control surface). */
function fakeHarness() {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }

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
      if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt: async () => {},
    close: end,
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

  return { emit, end, captured, queryFn }
}

function makeRunner(overrides: Partial<SessionRunnerConfig> = {}) {
  const harness = fakeHarness()
  const runner = new SessionRunner({
    cwd: '/tmp/project',
    queryFn: harness.queryFn,
    ...overrides,
  })
  return { harness, runner }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let uuidCounter = 0
const nextUuid = () => `uuid-${++uuidCounter}`

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Task', 'Bash'],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

const taskCall = (id: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use',
  id,
  name: 'Task',
  input,
})

const toolCall = (id: string, name = 'Bash') => ({ type: 'tool_use', id, name, input: {} })

const assistant = (content: unknown, parent: string | null = null) =>
  ({
    type: 'assistant',
    message: { role: 'assistant', content, model: 'claude-test-1', stop_reason: 'end_turn' },
    parent_tool_use_id: parent,
    uuid: nextUuid(),
    session_id: 'sdk-session-1',
  }) as unknown as SDKMessage

const user = (content: unknown, parent: string | null = null, uuid = nextUuid()) =>
  ({
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: parent,
    uuid,
    session_id: 'sdk-session-1',
  }) as unknown as SDKMessage

const taskResult = (toolUseId: string, isError = false) =>
  user([{ type: 'tool_result', tool_use_id: toolUseId, content: 'report', is_error: isError }])

const turnResult = {
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
  uuid: nextUuid(),
  session_id: 'sdk-session-1',
} as unknown as SDKMessage

describe('SessionRunner sub-agent rollup', () => {
  it('is absent — not empty — on a session that has spawned nothing', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([{ type: 'text', text: 'no agents here' }, toolCall('t1')]))
    await tick()
    expect(runner.info().subagents).toBeUndefined()
  })

  it('opens on the Task call itself, labelled from its input, and settles done on its result', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(
      assistant([taskCall('task-1', { subagent_type: 'Explore', description: 'find the auth check' })]),
    )
    await tick()
    // Visible from the call, before any nested event arrives.
    expect(runner.info().subagents).toEqual([
      {
        toolUseId: 'task-1',
        agentType: 'Explore',
        description: 'find the auth check',
        status: 'running',
        startedAt: expect.any(Number),
        toolCount: 0,
      },
    ])

    harness.emit(taskResult('task-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'done' }])
  })

  it('reports the Task’s own failure from is_error', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore' })]))
    harness.emit(taskResult('task-1', true))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'failed' }])
  })

  it('trims, blanks and clips the labels — model-authored input rides every list poll', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(
      assistant([taskCall('task-1', { subagent_type: '   ', description: 'x'.repeat(200) })]),
    )
    await tick()
    const [record] = runner.info().subagents!
    expect(record.agentType).toBeUndefined()
    expect(record.description).toHaveLength(80)
    expect(record.description!.endsWith('…')).toBe(true)
  })

  it('counts nested tool_use blocks only — not prose, not deltas, not the main thread’s own calls', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore' }), toolCall('main-1')]))
    // The brief: a real user message inside the sidechain.
    harness.emit(user('Search the repo for X.', 'task-1'))
    harness.emit(
      assistant([{ type: 'text', text: 'Searching.' }, toolCall('c1', 'Grep'), toolCall('c2')], 'task-1'),
    )
    harness.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta' },
      parent_tool_use_id: 'task-1',
      uuid: nextUuid(),
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    harness.emit(assistant([toolCall('c3', 'Read')], 'task-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-1', status: 'running', toolCount: 3 },
    ])
  })

  it('keeps two parallel Tasks apart while their events interleave', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(
      assistant([
        taskCall('task-a', { subagent_type: 'Explore', description: 'A' }),
        taskCall('task-b', { subagent_type: 'Plan', description: 'B' }),
      ]),
    )
    // Interleaved — grouping by adjacency would shear these apart.
    harness.emit(assistant([toolCall('a1')], 'task-a'))
    harness.emit(assistant([toolCall('b1')], 'task-b'))
    harness.emit(assistant([toolCall('a2'), toolCall('a3')], 'task-a'))
    harness.emit(taskResult('task-b'))
    harness.emit(assistant([toolCall('a4')], 'task-a'))
    harness.emit(taskResult('task-a', true))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-a', agentType: 'Explore', status: 'failed', toolCount: 4 },
      { toolUseId: 'task-b', agentType: 'Plan', status: 'done', toolCount: 1 },
    ])
  })

  it('opens a label-less record for a parent id no Task call named, and upgrades it if one does', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    // A renamed spawner: nested events arrive for an id we never saw opened.
    harness.emit(user('Do the thing.', 'task-x'))
    harness.emit(assistant([toolCall('x1')], 'task-x'))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-x', status: 'running', toolCount: 1 },
    ])
    expect(runner.info().subagents![0].agentType).toBeUndefined()

    // The named call turning up fills labels in without resetting the count.
    harness.emit(assistant([taskCall('task-x', { subagent_type: 'Explore' })]))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-x', agentType: 'Explore', status: 'running', toolCount: 1 },
    ])
  })

  it('settles a Task the turn abandoned as failed — never a running badge on an idle session', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore' })]))
    harness.emit(assistant([toolCall('c1')], 'task-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'running' }])
    // Interrupt: no tool_result ever arrives, just the turn ending.
    harness.emit(turnResult)
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-1', status: 'failed', toolCount: 1 },
    ])
  })

  it('clears the rollup on conversation_reset — the Tasks belonged to a conversation that is gone', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore' })]))
    harness.emit(taskResult('task-1'))
    harness.emit(assistant([taskCall('task-2', { subagent_type: 'Plan' })]))
    await tick()
    expect(runner.info().subagents).toHaveLength(2)
    harness.emit({
      type: 'conversation_reset',
      new_conversation_id: 'sdk-session-2',
      uuid: nextUuid(),
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    await tick()
    expect(runner.info().subagents).toBeUndefined()
  })

  it('keeps every running record and only the newest SUBAGENT_HISTORY settled ones', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const settled = Array.from({ length: SUBAGENT_HISTORY + 2 }, (_, i) => `task-${i + 1}`)
    harness.emit(assistant([...settled.map((id) => taskCall(id)), taskCall('task-live')]))
    for (const id of settled) harness.emit(taskResult(id))
    await tick()
    const records = runner.info().subagents!
    // The two oldest-settled fell off; the running one is untouchable.
    expect(records.map((r) => r.toolUseId)).toEqual([...settled.slice(2), 'task-live'])
    expect(records.find((r) => r.toolUseId === 'task-live')).toMatchObject({ status: 'running' })
    expect(records.filter((r) => r.status !== 'running')).toHaveLength(SUBAGENT_HISTORY)
  })

  it('rebuilds from a resume backfill, and sweeps the Task the old process died inside', async () => {
    // History: one Task settled clean, one still open when the process ended.
    const history = [
      {
        type: 'user' as const,
        uuid: 'h-u1',
        session_id: 'sdk-session-prev',
        message: { role: 'user', content: 'go' },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'h-a1',
        session_id: 'sdk-session-prev',
        message: {
          role: 'assistant',
          content: [
            taskCall('task-done', { subagent_type: 'Explore', description: 'finished one' }),
            taskCall('task-cut', { subagent_type: 'Plan', description: 'interrupted one' }),
          ],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'h-a2',
        session_id: 'sdk-session-prev',
        message: { role: 'assistant', content: [toolCall('d1'), toolCall('d2')] },
        parent_tool_use_id: 'task-done',
        parent_agent_id: null,
      },
      {
        type: 'user' as const,
        uuid: 'h-u2',
        session_id: 'sdk-session-prev',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'task-done', content: 'report' }],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'h-a3',
        session_id: 'sdk-session-prev',
        message: { role: 'assistant', content: [toolCall('c1')] },
        parent_tool_use_id: 'task-cut',
        parent_agent_id: null,
      },
    ]
    const { harness, runner } = makeRunner({
      resume: 'sdk-session-prev',
      historyFn: async () => history as never,
    })
    void runner.start()
    harness.emit(initMessage)
    await tick()
    // No turn_result replays from history — the idle transition is the sweep.
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-done', agentType: 'Explore', status: 'done', toolCount: 2 },
      { toolUseId: 'task-cut', agentType: 'Plan', status: 'failed', toolCount: 1 },
    ])

    // The SDK re-streams user messages on resume; the duplicate result must not
    // double-settle or reshuffle what is retained.
    harness.emit(
      user(
        [{ type: 'tool_result', tool_use_id: 'task-done', content: 'report' }],
        null,
        'h-u2',
      ),
    )
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-done', status: 'done', toolCount: 2 },
      { toolUseId: 'task-cut', status: 'failed', toolCount: 1 },
    ])
  })
})
