import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent, SessionEventBody } from '@workerdeck/protocol'
import { SessionRunner } from '../src/index.ts'
import { AddressedThinking } from '../src/engines/claude/addressed-thinking.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'

function block(type: string, text = '') {
  return type === 'thinking' ? { type, thinking: text } : type === 'text' ? { type, text } : { type, id: 't1', name: 'Bash', input: {} }
}

function message(content: unknown[], parentToolUseId: string | null = null): SessionEventBody {
  return { type: 'assistant_message', message: { role: 'assistant', content }, parentToolUseId, uuid: 'u' } as SessionEventBody
}

function addressedOf(body: SessionEventBody): boolean[] {
  return body.type === 'assistant_message' && typeof body.message.content !== 'string'
    ? body.message.content.map((b) => (b as { addressed?: boolean }).addressed === true)
    : []
}

describe('AddressedThinking', () => {
  it('stamps the second of two thinking blocks in one API message, one block per event', () => {
    const stamper = new AddressedThinking()
    expect(addressedOf(stamper.stamp('m1', message([block('thinking', 'reasoning')])))).toEqual([false])
    expect(addressedOf(stamper.stamp('m1', message([block('thinking', 'Check 1 passes.')])))).toEqual([true])
    expect(addressedOf(stamper.stamp('m1', message([block('tool_use')])))).toEqual([false])
  })

  it('leaves a lone thinking block and a pair split across API messages alone', () => {
    const stamper = new AddressedThinking()
    stamper.stamp('m1', message([block('thinking', 'a')]))
    expect(addressedOf(stamper.stamp('m2', message([block('thinking', 'b')])))).toEqual([false])
    stamper.stamp('m3', message([block('text', 'hi')]))
    expect(addressedOf(stamper.stamp('m3', message([block('thinking', 'c')])))).toEqual([false])
  })

  it('stamps within a multi-block event and never stamps empty thinking', () => {
    const stamper = new AddressedThinking()
    expect(addressedOf(stamper.stamp('m1', message([block('thinking', 'a'), block('thinking', 'b'), block('thinking', ' ')])))).toEqual([
      false,
      true,
      false,
    ])
  })

  it('tracks a subagent separately from the root', () => {
    const stamper = new AddressedThinking()
    stamper.stamp('m1', message([block('thinking', 'root')]))
    stamper.stamp('s1', message([block('thinking', 'sub')], 'task-1'))
    expect(addressedOf(stamper.stamp('m1', message([block('thinking', 'to you')])))).toEqual([true])
  })
})

describe('SessionRunner addressed thinking', () => {
  const sdkAssistant = (id: string, content: unknown[], uuid: string) =>
    ({
      type: 'assistant',
      message: { id, role: 'assistant', content, model: 'claude-test-1' },
      parent_tool_use_id: null,
      uuid,
      session_id: 'sdk-session-1',
    }) as unknown as SDKMessage

  it('stamps the live stream by API message id', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    harness.emit(sdkAssistant('msg_1', [block('thinking', 'reasoning')], 'u1'))
    harness.emit(sdkAssistant('msg_1', [block('thinking', 'Two decisions from you.')], 'u2'))
    harness.emit(sdkAssistant('msg_1', [block('tool_use')], 'u3'))
    await tick()
    expect(events.filter((e) => e.type === 'assistant_message').map(addressedOf)).toEqual([[false], [true], [false]])
  })
})
