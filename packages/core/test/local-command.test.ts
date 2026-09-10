import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner, CodexRunner, SessionRunner, localCommandContext, localCommandTranscript } from '../src/index.ts'
import { streamText } from './helpers/ai-sdk-mocks.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { collect, ofType, scriptTurn, scriptedPeer, THREAD_RESULT } from './helpers/codex-peer.ts'
import { waitFor } from './helpers/wait.ts'

// The react reducer's own anchor, copied verbatim: every transcript text must be exactly one element.
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>$/

const OK = { command: 'echo hi', stdout: 'hi\n', stderr: '', exitCode: 0 }
const FAILED = { command: 'false', stdout: '', stderr: 'nope\n', exitCode: 1 }

type TextBlock = { type: string; text?: string }

function blocksOf(content: unknown): TextBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : (content as TextBlock[])
}

describe('local-command framing', () => {
  it('frames a success as stdout with the command line first', () => {
    const text = localCommandTranscript(OK)
    expect(text).toBe('<local-command-stdout>$ echo hi\nhi</local-command-stdout>')
    const match = LOCAL_COMMAND_OUTPUT.exec(text.trim())
    expect(match?.[1]).toBe('stdout')
    expect(match?.[2]).toBe('$ echo hi\nhi')
  })

  it('frames a failure as stderr and appends the exit code', () => {
    const text = localCommandTranscript(FAILED)
    expect(text).toBe('<local-command-stderr>$ false\nnope\n[exit 1]</local-command-stderr>')
    expect(LOCAL_COMMAND_OUTPUT.exec(text)?.[1]).toBe('stderr')
  })

  it('keeps both streams, stdout first, and omits empty ones', () => {
    expect(localCommandTranscript({ command: 'x', stdout: 'out\n\n', stderr: 'warn', exitCode: 0 })).toBe(
      '<local-command-stdout>$ x\nout\nwarn</local-command-stdout>',
    )
    expect(localCommandTranscript({ command: 'true', stdout: '', stderr: '', exitCode: 0 })).toBe(
      '<local-command-stdout>$ true</local-command-stdout>',
    )
  })

  it('prepends the caveat to the pending outputs, and is nothing when nothing is pending', () => {
    expect(localCommandContext([])).toBeUndefined()
    const context = localCommandContext(['<a>', '<b>'])!
    expect(context.startsWith('<local-command-caveat>Caveat: ')).toBe(true)
    expect(context.endsWith('</local-command-caveat>\n<a>\n<b>')).toBe(true)
  })
})

describe('SessionRunner (claude) local commands', () => {
  function makeRunner() {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    return { harness, runner, events }
  }

  it('emits a synthetic transcript event and pushes nothing to the SDK', async () => {
    const { harness, runner, events } = makeRunner()
    runner.queueLocalCommand!(OK)
    await tick()
    const users = ofType(events, 'user_message')
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ synthetic: true, message: { role: 'user', content: localCommandTranscript(OK) } })
    expect(users[0]!.uuid).toBeTruthy()
    expect(harness.captured.inputs).toHaveLength(0)
    expect(runner.info().activityCount).toBe(0)
    expect(runner.info().proseCount).toBe(0)
  })

  it('flushes the held output as a leading caveat block on the next message only', async () => {
    const { harness, runner, events } = makeRunner()
    runner.queueLocalCommand!(OK)
    runner.queueLocalCommand!(FAILED)
    runner.sendMessage('what happened?')
    await tick()
    expect(harness.captured.inputs).toHaveLength(1)
    const blocks = blocksOf(harness.captured.inputs[0]!.message.content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toBe(localCommandContext([localCommandTranscript(OK), localCommandTranscript(FAILED)]))
    expect(blocks[1]).toEqual({ type: 'text', text: 'what happened?' })
    const sent = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.message.content).toBe('what happened?')

    runner.sendMessage('and now?')
    await tick()
    expect(harness.captured.inputs[1]!.message.content).toBe('and now?')
  })

  it('accepts an empty text and attachments alongside the held output', async () => {
    const { harness, runner } = makeRunner()
    runner.queueLocalCommand!(OK)
    runner.sendMessage('')
    await tick()
    const alone = blocksOf(harness.captured.inputs[0]!.message.content)
    expect(alone).toHaveLength(1)
    expect(alone[0]!.text!.startsWith('<local-command-caveat>')).toBe(true)

    runner.queueLocalCommand!(OK)
    runner.sendMessage('look', [{ id: 'a1', name: 'p.png', mediaType: 'image/png', bytes: 4, data: 'AAAA' }])
    await tick()
    const withImage = blocksOf(harness.captured.inputs[1]!.message.content)
    expect(withImage.map((b) => b.type)).toEqual(['text', 'image', 'text'])
    expect(withImage[0]!.text!.startsWith('<local-command-caveat>')).toBe(true)
    expect(withImage[2]!.text).toBe('look')
  })

  it('holds the output across a slash command rather than flushing into it', async () => {
    const { harness, runner } = makeRunner()
    runner.queueLocalCommand!(OK)
    runner.sendMessage('/compact')
    runner.sendMessage('ok now')
    await tick()
    expect(harness.captured.inputs[0]!.message.content).toBe('/compact')
    const blocks = blocksOf(harness.captured.inputs[1]!.message.content)
    expect(blocks[0]!.text!.startsWith('<local-command-caveat>')).toBe(true)
    expect(blocks[1]!.text).toBe('ok now')
  })

  it('drops the held output on clearContext and on an engine conversation_reset', async () => {
    const { harness, runner } = makeRunner()
    runner.queueLocalCommand!(OK)
    await runner.clearContext()
    runner.sendMessage('fresh')
    await tick()
    expect(harness.captured.inputs.map((m) => m.message.content)).toEqual(['/clear', 'fresh'])

    runner.queueLocalCommand!(OK)
    harness.emit({ type: 'conversation_reset', new_conversation_id: 'sdk-2' } as unknown as SDKMessage)
    await tick()
    runner.sendMessage('after reset')
    await tick()
    expect(harness.captured.inputs[2]!.message.content).toBe('after reset')
  })

  it('refuses after close', () => {
    const { runner } = makeRunner()
    runner.close()
    expect(() => runner.queueLocalCommand!(OK)).toThrow(/closed/)
  })
})

describe('CodexRunner local commands', () => {
  it('flushes the held output as the first turn/start input part and echoes only the typed text', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    runner.queueLocalCommand!(OK)
    expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(false)
    expect(ofType(events, 'user_message')[0]).toMatchObject({ synthetic: true, message: { content: localCommandTranscript(OK) } })

    runner.sendMessage('so?')
    await vi.waitFor(() => expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(true))
    const input = (peer.requests.find((r) => r.method === 'turn/start')!.params as { input: Array<{ type: string; text?: string }> }).input
    expect(input.map((p) => p.type)).toEqual(['text', 'text'])
    expect(input[0]!.text).toBe(localCommandContext([localCommandTranscript(OK)]))
    expect(input[1]!.text).toBe('so?')
    const typed = ofType(events, 'user_message').filter((e) => !e.synthetic)
    expect(typed.map((e) => e.message.content)).toEqual(['so?'])
  })

  it('drops the held output when a bare /clear resets the thread', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    const inputs: string[][] = []
    peer.respond('turn/start', (params) => {
      const p = params as { threadId: string; input: Array<{ text?: string }> }
      inputs.push(p.input.map((part) => part.text ?? ''))
      const turnId = `turn-${inputs.length}`
      peer.emit('turn/started', { threadId: p.threadId, turn: { id: turnId, status: 'inProgress' } })
      peer.emit('turn/completed', { threadId: p.threadId, turn: { id: turnId, status: 'completed' } })
      return { turn: { id: turnId, status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    runner.queueLocalCommand!(OK)
    runner.sendMessage('/clear')
    await runner.interrupt()
    expect(ofType(events, 'conversation_reset')).toHaveLength(1)

    runner.sendMessage('after')
    await runner.interrupt()
    expect(inputs).toEqual([['hi'], ['after']])
  })
})

describe('AiSdkRunner local commands', () => {
  it('flushes into the model-facing user message, keeps the event plain, and survives a snapshot', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: streamText('ok') })
    const runner = new AiSdkRunner({ languageModel: model })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.queueLocalCommand!(OK)
    await waitFor(() => runner.info().status === 'idle')

    const snapshot = runner.snapshot()!
    expect((snapshot.state as { pendingLocalCommands?: string[] }).pendingLocalCommands).toEqual([localCommandTranscript(OK)])
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)

    const restored = new AiSdkRunner({ languageModel: model, restore: snapshot })
    const restoredEvents: SessionEvent[] = []
    restored.subscribe((e) => restoredEvents.push(e), snapshot.seq)
    void restored.start()
    restored.sendMessage('well?')
    await waitFor(() => restoredEvents.some((e) => e.type === 'turn_result'))
    const user = restored.messages.find((m) => m.role === 'user')!
    const blocks = blocksOf(user.content)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.text).toBe(localCommandContext([localCommandTranscript(OK)]))
    expect(blocks[1]).toEqual({ type: 'text', text: 'well?' })
    const typed = restoredEvents.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message' && !e.synthetic,
    )
    expect(typed.map((e) => e.message.content)).toEqual(['well?'])
    expect(restored.snapshot()!.state).not.toHaveProperty('pendingLocalCommands')
  })

  it('drops the held output on clearContext', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: streamText('ok') })
    const runner = new AiSdkRunner({ languageModel: model })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.queueLocalCommand!(OK)
    await runner.clearContext()
    runner.sendMessage('fresh')
    await waitFor(() => events.some((e) => e.type === 'turn_result'))
    expect(runner.messages[0]).toEqual({ role: 'user', content: 'fresh' })
  })
})
