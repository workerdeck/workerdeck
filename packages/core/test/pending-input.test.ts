import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SessionRunner } from '../src/index.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: [],
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

function assistant(answering: string | undefined, n: number): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `reply ${n}` }], model: 'claude-test-1', stop_reason: 'end_turn' },
    parent_tool_use_id: null,
    uuid: `uuid-a${n}`,
    session_id: 'sdk-1',
    ...(answering === undefined ? {} : { user_message_uuid: answering }),
  } as unknown as SDKMessage
}

function result(subtype = 'success'): SDKMessage {
  return {
    type: 'result',
    subtype,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== 'success',
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: `uuid-r-${Math.random()}`,
    session_id: 'sdk-1',
  } as unknown as SDKMessage
}

async function running() {
  const harness = fakeHarness()
  const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
  void runner.start()
  await tick()
  harness.emit(init)
  await tick()
  return { harness, runner }
}

describe('claude pendingInput', () => {
  it('keeps a message queued during a turn pending past that turn result, until a frame names it', async () => {
    const { harness, runner } = await running()
    runner.sendMessage('first')
    await tick()
    const first = harness.captured.inputs[0]!.uuid!
    harness.emit(assistant(first, 1))
    await tick()
    runner.sendMessage('from a peer', undefined, { origin: { kind: 'peer', sessionId: 'p', name: 'P', engine: 'claude', hops: [] } })
    await tick()
    harness.emit(result())
    await tick()
    expect(runner.pendingInput()).toBe(1)
    const queued = harness.captured.inputs[1]!.uuid!
    harness.emit(assistant(queued, 2))
    await tick()
    expect(runner.pendingInput()).toBe(0)
  })

  it('does not lose a pending message behind many events', async () => {
    const { harness, runner } = await running()
    runner.sendMessage('one')
    runner.sendMessage('two')
    await tick()
    harness.emit(assistant(harness.captured.inputs[0]!.uuid!, 0))
    await tick()
    for (let n = 1; n <= 600; n++) {
      harness.emit(assistant(undefined, n))
      await tick()
    }
    harness.emit(result())
    await tick()
    expect(runner.pendingInput()).toBe(1)
  })

  it('never holds a slash command that runs no turn, and lets an interrupted turn consume its send', async () => {
    const { harness, runner } = await running()
    runner.sendMessage('/cost')
    await tick()
    expect(runner.pendingInput()).toBe(0)
    runner.sendMessage('stop me')
    await tick()
    harness.emit(result('error_during_execution'))
    await tick()
    expect(runner.pendingInput()).toBe(0)
  })
})
