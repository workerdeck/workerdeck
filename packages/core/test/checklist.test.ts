import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { CHECKLIST_TEXT_MAX, type SessionEvent } from '@workerdeck/protocol'
import { SessionRunner, type SessionRunnerConfig } from '../src/index.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'

function makeRunner(overrides: Partial<SessionRunnerConfig> = {}) {
  const harness = fakeHarness()
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn, ...overrides })
  return { harness, runner }
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
  tools: ['TodoWrite'],
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

type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

function todoWrite(id: string, todos: unknown) {
  return { type: 'tool_use', id, name: 'TodoWrite', input: { todos } }
}

function todo(status: Todo['status'], content: string): Todo {
  return { content, status }
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

function collect(runner: SessionRunner): SessionEvent[] {
  const events: SessionEvent[] = []
  runner.subscribe((event) => events.push(event))
  return events
}

describe('SessionRunner checklist rollup', () => {
  it('is absent on a session that has written none', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([{ type: 'text', text: 'nothing planned' }]))
    await tick()
    expect(runner.info().checklist).toBeUndefined()
  })

  it('folds a root TodoWrite into info and emits one event', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const events = collect(runner)
    harness.emit(assistant([todoWrite('w1', [todo('completed', 'read'), todo('in_progress', 'write')])]))
    await tick()
    expect(runner.info().checklist).toEqual([
      { text: 'read', status: 'completed' },
      { text: 'write', status: 'in_progress' },
    ])
    expect(events.filter((e) => e.type === 'checklist')).toHaveLength(1)
  })

  it('delivers the checklist after the message that produced it', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const events = collect(runner)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'plan')])]))
    await tick()
    const message = events.find((e) => e.type === 'assistant_message')
    const checklist = events.find((e) => e.type === 'checklist')
    expect(checklist!.seq).toBeGreaterThan(message!.seq)
    expect(events.indexOf(checklist!)).toBeGreaterThan(events.indexOf(message!))
  })

  it('ignores a sub-agent own list', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'child work')])], 'task-1'))
    await tick()
    expect(runner.info().checklist).toBeUndefined()
  })

  it('says nothing when the list is rewritten unchanged', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const events = collect(runner)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'plan')])]))
    await tick()
    harness.emit(assistant([todoWrite('w2', [todo('pending', 'plan')])]))
    await tick()
    expect(events.filter((e) => e.type === 'checklist')).toHaveLength(1)
  })

  it('leaves the standing list alone when a write is malformed', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'plan')])]))
    await tick()
    harness.emit(assistant([todoWrite('w2', [{ content: 'ok', status: 'paused' }])]))
    await tick()
    expect(runner.info().checklist).toEqual([{ text: 'plan', status: 'pending' }])
  })

  it('clears on a well-formed empty list', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'plan')])]))
    await tick()
    harness.emit(assistant([todoWrite('w2', [])]))
    await tick()
    expect(runner.info().checklist).toBeUndefined()
  })

  it('clamps a text longer than the wire allows', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'x'.repeat(CHECKLIST_TEXT_MAX + 50))])]))
    await tick()
    expect(runner.info().checklist?.[0]?.text).toHaveLength(CHECKLIST_TEXT_MAX)
  })

  it('survives a turn ending', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistant([todoWrite('w1', [todo('in_progress', 'write')])]))
    await tick()
    harness.emit({
      type: 'result',
      subtype: 'success',
      duration_ms: 1,
      duration_api_ms: 1,
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
    } as unknown as SDKMessage)
    await tick()
    expect(runner.info().checklist).toEqual([{ text: 'write', status: 'in_progress' }])
  })

  it('clears on a reset, and re-arms for an identical list after it', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    const events = collect(runner)
    harness.emit(assistant([todoWrite('w1', [todo('pending', 'plan')])]))
    await tick()
    harness.emit({ type: 'conversation_reset', new_conversation_id: 'sdk-session-2', uuid: nextUuid() } as unknown as SDKMessage)
    await tick()
    expect(runner.info().checklist).toBeUndefined()
    harness.emit(assistant([todoWrite('w2', [todo('pending', 'plan')])]))
    await tick()
    expect(runner.info().checklist).toEqual([{ text: 'plan', status: 'pending' }])
    expect(events.filter((e) => e.type === 'checklist')).toHaveLength(2)
  })

  it('rebuilds from a resume backfill, last write winning', async () => {
    const history = [
      {
        type: 'assistant' as const,
        uuid: 'h-a1',
        session_id: 'sdk-session-prev',
        message: { role: 'assistant', content: [todoWrite('w1', [todo('pending', 'first')])] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'h-a2',
        session_id: 'sdk-session-prev',
        message: { role: 'assistant', content: [todoWrite('w2', [todo('completed', 'first'), todo('in_progress', 'second')])] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]
    const { harness, runner } = makeRunner({ resume: 'sdk-session-prev', historyFn: async () => history as never })
    void runner.start()
    harness.emit(initMessage)
    await tick()
    expect(runner.info().checklist).toEqual([
      { text: 'first', status: 'completed' },
      { text: 'second', status: 'in_progress' },
    ])
  })
})
