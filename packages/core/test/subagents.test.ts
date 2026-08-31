import { describe, expect, it } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { SUBAGENT_HISTORY } from '@workerdeck/protocol'
import { SessionRunner, type SessionRunnerConfig } from '../src/index.ts'

// Minimal stand-in for the SDK: emit SDKMessages, capture options + streamed input (the
// runner.test.ts harness without its control surface).
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

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

let uuidCounter = 0
function nextUuid() {
  return `uuid-${++uuidCounter}`
}

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

function taskCall(id: string, input: Record<string, unknown> = {}) {
  return {
    type: 'tool_use',
    id,
    name: 'Task',
    input,
  }
}

// The async spawner, as a captured real session spelled it (`Agent`, not `Task`).
function agentCall(id: string, input: Record<string, unknown> = {}) {
  return {
    type: 'tool_use',
    id,
    name: 'Agent',
    input,
  }
}

// The launch receipt, verbatim from the captured session: it resolves the spawn call seconds
// after launch, long before the agent has done anything.
const ACK_TEXT =
  'Async agent launched successfully. (This tool result is internal metadata — never quote ' +
  'or paste any part of it, including the agentId below, into a user-facing reply.)\n' +
  'agentId: a5ae18bf55ec3c1b1 (internal ID - do not mention to user.)\n' +
  'The agent is working in the background. You will be notified automatically when it completes.'

function launchAck(toolUseId: string, uuid = nextUuid()) {
  return user([{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: ACK_TEXT }] }], null, uuid)
}

// The CLI's background-task lifecycle, live: system messages passed through as `sdk_event`
// bodies. Shapes from the captured session.
function taskStarted(taskId: string, toolUseId: string, subagentType: string, description: string) {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description,
    subagent_type: subagentType,
    task_type: 'local_agent',
    prompt: 'the brief',
    uuid: nextUuid(),
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

function taskNotification(taskId: string, toolUseId: string, status: string) {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    output_file: `/tmp/tasks/${taskId}.output`,
    summary: 'Agent finished',
    uuid: nextUuid(),
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

// The same fact as a resume replays it: a plain-string user message wearing the
// `<task-notification>` wrapper. None of the system events above are stored in the JSONL.
function notificationText(taskId: string, toolUseId: string, status: string) {
  return (
    `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
    `<output-file>/tmp/tasks/${taskId}.output</output-file>\n<status>${status}</status>\n` +
    `<summary>Agent "the brief" finished</summary>\n` +
    '<note>A task-notification fires each time this agent stops with no live background children ' +
    'of its own.</note>\n<result>## Results\n\nEverything found.</result>'
  )
}

function toolCall(id: string, name = 'Bash') {
  return { type: 'tool_use', id, name, input: {} }
}

function assistant(content: unknown, parent: string | null = null) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content, model: 'claude-test-1', stop_reason: 'end_turn' },
    parent_tool_use_id: parent,
    uuid: nextUuid(),
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

function user(content: unknown, parent: string | null = null, uuid = nextUuid()) {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: parent,
    uuid,
    session_id: 'sdk-session-1',
  } as unknown as SDKMessage
}

function taskResult(toolUseId: string, isError = false) {
  return user([{ type: 'tool_result', tool_use_id: toolUseId, content: 'report', is_error: isError }])
}

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
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore', description: 'find the auth check' })]))
    await tick()
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
    harness.emit(assistant([taskCall('task-1', { subagent_type: '   ', description: 'x'.repeat(200) })]))
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
    harness.emit(user('Search the repo for X.', 'task-1'))
    harness.emit(assistant([{ type: 'text', text: 'Searching.' }, toolCall('c1', 'Grep'), toolCall('c2')], 'task-1'))
    harness.emit({
      type: 'stream_event',
      event: { type: 'content_block_delta' },
      parent_tool_use_id: 'task-1',
      uuid: nextUuid(),
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    harness.emit(assistant([toolCall('c3', 'Read')], 'task-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'running', toolCount: 3 }])
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
    harness.emit(user('Do the thing.', 'task-x'))
    harness.emit(assistant([toolCall('x1')], 'task-x'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-x', status: 'running', toolCount: 1 }])
    expect(runner.info().subagents![0].agentType).toBeUndefined()

    harness.emit(assistant([taskCall('task-x', { subagent_type: 'Explore' })]))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-x', agentType: 'Explore', status: 'running', toolCount: 1 }])
  })

  it('settles a Task the turn abandoned as failed — never a running badge on an idle session', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([taskCall('task-1', { subagent_type: 'Explore' })]))
    harness.emit(assistant([toolCall('c1')], 'task-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'running' }])
    harness.emit(turnResult)
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'task-1', status: 'failed', toolCount: 1 }])
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
    for (const id of settled) {
      harness.emit(taskResult(id))
    }
    await tick()
    const records = runner.info().subagents!
    expect(records.map((r) => r.toolUseId)).toEqual([...settled.slice(2), 'task-live'])
    expect(records.find((r) => r.toolUseId === 'task-live')).toMatchObject({ status: 'running' })
    expect(records.filter((r) => r.status !== 'running')).toHaveLength(SUBAGENT_HISTORY)
  })

  it('rebuilds from a resume backfill, and sweeps the Task the old process died inside', async () => {
    // One Task settled clean, one still open when the process ended.
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
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-done', agentType: 'Explore', status: 'done', toolCount: 2 },
      { toolUseId: 'task-cut', agentType: 'Plan', status: 'failed', toolCount: 1 },
    ])

    harness.emit(user([{ type: 'tool_result', tool_use_id: 'task-done', content: 'report' }], null, 'h-u2'))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'task-done', status: 'done', toolCount: 2 },
      { toolUseId: 'task-cut', status: 'failed', toolCount: 1 },
    ])
  })
})

// Shapes condensed from a captured session (5c753c85…): three Explore agents spawned through
// a tool named `Agent`, each spawn call resolved by a launch receipt, three turns ended while
// they ran, and each verdict delivered as a `task_notification`.
describe('SessionRunner background sub-agents', () => {
  it('survives the turn ending mid-flight, and settles on its notification — the captured shape', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const id = 'toolu_01RHsVuxRA5JDJ2n4ywoSKjU'
    harness.emit(
      assistant([
        agentCall(id, {
          description: 'Grep iOS terminal symbols',
          subagent_type: 'Explore',
          prompt: 'This is a read-only test fixture task…',
        }),
      ]),
    )
    harness.emit(taskStarted('a5ae18bf55ec3c1b1', id, 'Explore', 'Grep iOS terminal symbols'))
    harness.emit(launchAck(id))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      {
        toolUseId: id,
        agentType: 'Explore',
        description: 'Grep iOS terminal symbols',
        status: 'running',
        toolCount: 0,
      },
    ])

    harness.emit(assistant([toolCall('n1')], id))
    harness.emit(assistant([{ type: 'text', text: 'All three Explore agents are launched and running.' }]))
    harness.emit(turnResult)
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: id, status: 'running' }])

    harness.emit(assistant([toolCall('n2'), toolCall('n3')], id))
    harness.emit(taskNotification('a5ae18bf55ec3c1b1', id, 'completed'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: id, status: 'done', toolCount: 3 }])
  })

  it('reads a notification that is not `completed` as the agent failing', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([agentCall('agent-1', { subagent_type: 'Explore' })]))
    harness.emit(taskStarted('t-1', 'agent-1', 'Explore', 'brief'))
    harness.emit(launchAck('agent-1'))
    harness.emit(taskNotification('t-1', 'agent-1', 'stopped'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'agent-1', status: 'failed' }])
  })

  it('settles an un-notified background agent when the session closes — its process is gone', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([agentCall('agent-1', { subagent_type: 'Explore' })]))
    harness.emit(taskStarted('t-1', 'agent-1', 'Explore', 'brief'))
    harness.emit(launchAck('agent-1'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'agent-1', status: 'running' }])
    harness.end()
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'agent-1', status: 'failed' }])
  })

  it('opens, labels and settles from the lifecycle events alone — a third spawner spelling', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([toolCall('spawn-x', 'LaunchAgent')]))
    await tick()
    expect(runner.info().subagents).toBeUndefined()
    harness.emit(taskStarted('t-x', 'spawn-x', 'Explore', 'find the auth check'))
    harness.emit(launchAck('spawn-x'))
    harness.emit(assistant([toolCall('x1')], 'spawn-x'))
    await tick()
    expect(runner.info().subagents).toMatchObject([
      {
        toolUseId: 'spawn-x',
        agentType: 'Explore',
        description: 'find the auth check',
        status: 'running',
        toolCount: 1,
      },
    ])
    harness.emit(taskNotification('t-x', 'spawn-x', 'completed'))
    await tick()
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'spawn-x', status: 'done' }])
  })

  it('rebuilds from a resume backfill: the stored notification is the verdict, and a never-notified agent died with its process', async () => {
    // The stored JSONL carries no system events and no async sidechain — just spawn blocks,
    // launch receipts and `<task-notification>` wrappers.
    const history = [
      {
        type: 'user' as const,
        uuid: 'h-u1',
        session_id: 'sdk-session-prev',
        message: { role: 'user', content: 'launch two agents' },
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
            agentCall('agent-done', { subagent_type: 'Explore', description: 'finished one' }),
            agentCall('agent-dead', { subagent_type: 'Explore', description: 'cut off one' }),
          ],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'user' as const,
        uuid: 'h-u2',
        session_id: 'sdk-session-prev',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'agent-done', content: [{ type: 'text', text: ACK_TEXT }] }],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'user' as const,
        uuid: 'h-u3',
        session_id: 'sdk-session-prev',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'agent-dead', content: [{ type: 'text', text: ACK_TEXT }] }],
        },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'user' as const,
        uuid: 'h-u4',
        session_id: 'sdk-session-prev',
        message: { role: 'user', content: notificationText('t-done', 'agent-done', 'completed') },
        parent_tool_use_id: null,
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
    expect(runner.info().subagents).toMatchObject([
      { toolUseId: 'agent-done', agentType: 'Explore', description: 'finished one', status: 'done' },
      { toolUseId: 'agent-dead', agentType: 'Explore', description: 'cut off one', status: 'failed' },
    ])
  })

  it('opens from the replayed receipt alone when the spawner name is unknown', async () => {
    const history = [
      {
        type: 'user' as const,
        uuid: 'h-u1',
        session_id: 'sdk-session-prev',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'spawn-y', content: [{ type: 'text', text: ACK_TEXT }] }],
        },
        parent_tool_use_id: null,
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
    expect(runner.info().subagents).toMatchObject([{ toolUseId: 'spawn-y', status: 'failed' }])
  })
})
