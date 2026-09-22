import { describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SHELL_CONTEXT_HEAD_CHARS, SHELL_CONTEXT_TAIL_CHARS, type SessionEvent, type ShellInfo } from '@workerdeck/protocol'
import {
  AiSdkRunner,
  CodexRunner,
  LocalCommandQueue,
  SessionRunner,
  localCommandContext,
  localCommandTranscript,
  shellContextText,
  shellInlineText,
  type LocalShellSource,
} from '../src/index.ts'
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

const SHELL: ShellInfo = {
  id: 'sh_abc123def456',
  sessionId: 's1',
  ordinal: 3,
  command: 'npm test',
  label: 'npm test',
  cwd: '/tmp/project',
  owner: 'user',
  status: 'running',
  startedAt: 0,
  bytes: 0,
  cols: 120,
  rows: 40,
}

function numbered(n: number, prefix = 'line', width = 0): string {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`.padEnd(width, '.')).join('\n')
}

function exited(exitCode: number, extra: Partial<ShellInfo> = {}): ShellInfo {
  return { ...SHELL, status: 'exited', exitCode, endReason: 'exit', endedAt: 1, ...extra }
}

function running(startedAgoMs = 130_000): ShellInfo {
  return { ...SHELL, startedAt: Date.now() - startedAgoMs }
}

function bodyOf(text: string): string {
  return LOCAL_COMMAND_OUTPUT.exec(text)![2]!
}

// A record the server would own: `set` is what a chunk of output or an exit does, and it notifies like the registry will.
function fakeShell(info: ShellInfo = running(), text = '') {
  const listeners = new Set<() => void>()
  let current = info
  let output = text
  const source: LocalShellSource = {
    info: () => current,
    text: () => output,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    source,
    set(next: { info?: Partial<ShellInfo>; text?: string }) {
      current = next.info ? { ...current, ...next.info } : current
      output = next.text ?? output
      for (const listener of listeners) {
        listener()
      }
    },
    listeners: () => listeners.size,
  }
}

function collectQueue() {
  const emitted: Array<{ text: string; uuid: string; shell: ShellInfo | undefined }> = []
  const queue = new LocalCommandQueue((text, uuid, shell) => emitted.push({ text, uuid, shell }))
  return { queue, emitted }
}

describe('shellInlineText', () => {
  it('shows the command and the first SHELL_INLINE_LINES lines of a running shell as stdout', () => {
    const text = shellInlineText(running(), numbered(12))
    expect(LOCAL_COMMAND_OUTPUT.exec(text)?.[1]).toBe('stdout')
    expect(bodyOf(text)).toBe(`$ npm test\n${numbered(8)}\n[... 4 more lines ...]`)
  })

  it('is stderr with an exit line after a non-zero exit, stdout after a clean one', () => {
    const failed = shellInlineText(exited(1), 'nope')
    expect(LOCAL_COMMAND_OUTPUT.exec(failed)?.[1]).toBe('stderr')
    expect(bodyOf(failed)).toBe('$ npm test\nnope\n[exit 1]')
    const clean = shellInlineText(exited(0), 'fine')
    expect(LOCAL_COMMAND_OUTPUT.exec(clean)?.[1]).toBe('stdout')
    expect(bodyOf(clean)).toBe('$ npm test\nfine')
  })

  it('names the reason when a shell ended without an exit code', () => {
    expect(bodyOf(shellInlineText(exited(0, { exitCode: undefined, endReason: 'killed' }), ''))).toBe('$ npm test\n[killed]')
    const restarted = shellInlineText(exited(0, { exitCode: undefined, endReason: 'server_restarted' }), 'partial')
    expect(LOCAL_COMMAND_OUTPUT.exec(restarted)?.[1]).toBe('stderr')
    expect(bodyOf(restarted)).toContain('[ended: the gateway restarted; the process may still be running]')
  })
})

describe('shellContextText', () => {
  it('flushes an exited shell as head, omission pointer and tail within the context bounds', () => {
    const text = shellContextText(exited(1), numbered(300))
    expect(LOCAL_COMMAND_OUTPUT.exec(text)?.[1]).toBe('stderr')
    const lines = bodyOf(text).split('\n')
    expect(lines[0]).toBe('$ npm test')
    expect(lines.slice(1, 41)).toEqual(numbered(40).split('\n'))
    expect(lines[41]).toBe('[shell #3 (sh_abc123def456): 180 of 300 lines omitted (3 KiB in all); the full output is in the transcript]')
    expect(lines.slice(42, 122)).toEqual(numbered(300).split('\n').slice(220))
    expect(lines[122]).toBe('[exit 1]')
    expect(lines).toHaveLength(123)
  })

  it('keeps the head and tail inside their char budgets', () => {
    const text = shellContextText(exited(0), numbered(400, 'wide', 200))
    const [head, pointer, tail] = bodyOf(text).split(/\n(?=\[shell #3)|(?<=transcript\])\n/)
    expect(head!.length - '$ npm test\n'.length).toBeLessThanOrEqual(SHELL_CONTEXT_HEAD_CHARS)
    expect(tail!.length).toBeLessThanOrEqual(SHELL_CONTEXT_TAIL_CHARS)
    expect(pointer).toMatch(
      /^\[shell #3 \(sh_abc123def456\): \d+ of 400 lines omitted \(\d+ KiB in all\); the full output is in the transcript\]$/,
    )
  })

  it('carries a small output whole, without a pointer', () => {
    expect(bodyOf(shellContextText(exited(0), 'a\nb\n'))).toBe('$ npm test\na\nb')
    expect(bodyOf(shellContextText(exited(2), ''))).toBe('$ npm test\n[exit 2]')
  })

  it('collapses an exited shell to the pointer alone', () => {
    const text = bodyOf(shellContextText(exited(1), numbered(300), { collapsed: true }))
    expect(text).toBe(
      '$ npm test\n[shell #3 (sh_abc123def456): all 300 lines omitted (3 KiB); the full output is in the transcript]\n[exit 1]',
    )
  })

  it('flushes a running shell the first time as a status line plus the bounded tail', () => {
    const text = shellContextText(running(), numbered(300))
    expect(LOCAL_COMMAND_OUTPUT.exec(text)?.[1]).toBe('stdout')
    const lines = bodyOf(text).split('\n')
    expect(lines[0]).toBe('$ npm test')
    expect(lines[1]).toMatch(
      /^\[shell #3 \(sh_abc123def456\) is still running as of the time this was written \(started 2m 1\ds ago, 300 lines so far\)\. Nothing from it streams into this conversation; the full output is in the transcript\.\]$/,
    )
    expect(lines[2]).toBe('[last 80 of 300 lines]')
    expect(lines.slice(3)).toEqual(numbered(300).split('\n').slice(220))
  })

  it('flushes a running shell later as the status line only, counting the new lines', () => {
    const later = bodyOf(shellContextText(running(), numbered(340), { previous: { lines: 300 } }))
    expect(later).toMatch(/^\$ npm test\n\[shell #3 \(sh_abc123def456\) is still running .*40 new lines since the last message\).*\]$/s)
    expect(later).not.toContain('line-')
    const quiet = bodyOf(shellContextText(running(), numbered(300), { previous: { lines: 300 } }))
    expect(quiet).toContain('no new lines since the last message')
    const collapsed = bodyOf(shellContextText(running(), numbered(300), { collapsed: true }))
    expect(collapsed).toContain('300 lines so far')
    expect(collapsed).not.toContain('line-')
  })

  it('never reads a reconciled shell as a clean exit', () => {
    const text = shellContextText(exited(0, { exitCode: undefined, endReason: 'server_restarted' }), 'booting\n')
    expect(LOCAL_COMMAND_OUTPUT.exec(text)?.[1]).toBe('stderr')
    expect(bodyOf(text)).toBe('$ npm test\nbooting\n[ended: the gateway restarted; the process may still be running]')
  })
})

describe('LocalCommandQueue', () => {
  it('emits the row on push and re-emits it under the same uuid on every record change', () => {
    const { queue, emitted } = collectQueue()
    const shell = fakeShell(running(), 'starting')
    queue.push(shell.source)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.shell).toMatchObject({ id: 'sh_abc123def456', status: 'running' })
    expect(emitted[0]!.text).toBe(shellInlineText(shell.source.info(), 'starting'))

    shell.set({ text: 'starting\nlistening on :3000' })
    shell.set({ info: { status: 'exited', exitCode: 0, endReason: 'exit' } })
    expect(emitted).toHaveLength(3)
    expect(new Set(emitted.map((e) => e.uuid)).size).toBe(1)
    expect(emitted[1]!.text).toContain('listening on :3000')
    expect(emitted[2]!.shell?.status).toBe('exited')
    expect(emitted[1]!.shell?.status).toBe('running')
  })

  it('keeps a running shell pending after its flush, and lets its exit flush once before it leaves', () => {
    const { queue } = collectQueue()
    const shell = fakeShell(running(), numbered(300))
    queue.push(shell.source)

    const first = queue.take()!
    expect(first).toContain('300 lines so far')
    expect(first).toContain('[last 80 of 300 lines]')

    shell.set({ text: numbered(340) })
    const second = queue.take()!
    expect(second).toContain('40 new lines since the last message')
    expect(second).not.toContain('line-')
    expect(shell.listeners()).toBe(1)

    shell.set({ info: { status: 'exited', exitCode: 1, endReason: 'exit' } })
    const third = queue.take()!
    expect(third).toContain('[exit 1]')
    expect(third).toContain('line-340')
    expect(third).toContain('220 of 340 lines omitted')
    expect(shell.listeners()).toBe(0)
    expect(queue.take()).toBeUndefined()
  })

  it('settles a shell that exits before its first flush, and a one-shot result, on that flush', () => {
    const { queue, emitted } = collectQueue()
    const shell = fakeShell(exited(0), 'done')
    queue.push(OK)
    queue.push(shell.source)
    expect(emitted.map((e) => e.shell?.id)).toEqual([undefined, 'sh_abc123def456'])
    expect(queue.take()).toBe(localCommandContext([localCommandTranscript(OK), shellContextText(exited(0), 'done')]))
    expect(queue.take()).toBeUndefined()
    expect(shell.listeners()).toBe(0)
  })

  it('collapses the oldest shells to a status line and pointer once the per-flush cap is spent', () => {
    const { queue } = collectQueue()
    // Each exited body is 12,282 chars, so four fit under SHELL_CONTEXT_FLUSH_MAX_CHARS and the fifth tips it.
    for (let i = 0; i < 6; i++) {
      queue.push(fakeShell({ ...exited(0), ordinal: i }, numbered(200, `s${i}`, 100)).source)
    }
    const flush = queue.take()!
    expect(flush.match(/all 200 lines omitted/g)).toHaveLength(2)
    expect(flush).not.toContain('s0-1.')
    expect(flush).not.toContain('s1-1.')
    expect(flush).toContain('s2-200')
    expect(flush).toContain('s5-200')
    expect(flush.indexOf('shell #0')).toBeLessThan(flush.indexOf('shell #5'))
    expect(queue.take()).toBeUndefined()
  })

  it('materialises the pending entries as frozen strings without settling them, and restores them', () => {
    const { queue } = collectQueue()
    const shell = fakeShell(running(), numbered(3))
    queue.push(shell.source)
    const frozen = queue.materialize()
    expect(frozen).toHaveLength(1)
    expect(frozen[0]).toContain('is still running as of the time this was written')
    expect(frozen[0]).toContain('line-3')
    expect(queue.take()).toBe(localCommandContext(frozen))

    const restored = collectQueue()
    restored.queue.restore(frozen)
    expect(restored.emitted).toHaveLength(0)
    expect(restored.queue.take()).toBe(localCommandContext(frozen))
    expect(restored.queue.take()).toBeUndefined()
  })

  it('clear drops everything pending and stops listening', () => {
    const { queue, emitted } = collectQueue()
    const shell = fakeShell()
    queue.push(shell.source)
    queue.clear()
    expect(shell.listeners()).toBe(0)
    shell.set({ text: 'more' })
    expect(emitted).toHaveLength(1)
    expect(queue.take()).toBeUndefined()
  })
})

describe('shell sources on the runners', () => {
  function expectOneRow(events: SessionEvent[]) {
    const rows = ofType(events, 'user_message')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ synthetic: true, shell: { id: 'sh_abc123def456', status: 'running' } })
    expect(rows[1]).toMatchObject({ synthetic: true, shell: { id: 'sh_abc123def456', status: 'exited', exitCode: 0 } })
    expect(rows[0]!.uuid).toBeTruthy()
    expect(rows[1]!.uuid).toBe(rows[0]!.uuid)
    expect(rows[1]!.message.content).toBe(shellInlineText(exited(0), 'ok'))
  }

  it('claude re-emits the row under one uuid and hands the SDK only the flush text', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    const shell = fakeShell(running(), 'booting')
    runner.queueLocalCommand!(shell.source)
    shell.set({ info: exited(0), text: 'ok' })
    await tick()
    expectOneRow(events)
    expect(harness.captured.inputs).toHaveLength(0)

    runner.sendMessage('and?')
    await tick()
    const blocks = blocksOf(harness.captured.inputs[0]!.message.content)
    expect(blocks).toEqual([
      { type: 'text', text: localCommandContext([shellContextText(exited(0), 'ok')]) },
      { type: 'text', text: 'and?' },
    ])
    expect(JSON.stringify(harness.captured.inputs)).not.toContain('"shell"')
    expect(shell.listeners()).toBe(0)
  })

  it('codex re-emits the row under one uuid and hands turn/start only the flush text', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    const events = collect(runner)
    void runner.start()
    const shell = fakeShell(running(), 'booting')
    runner.queueLocalCommand!(shell.source)
    shell.set({ info: exited(0), text: 'ok' })
    expectOneRow(events)
    expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(false)

    runner.sendMessage('and?')
    await vi.waitFor(() => expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(true))
    const start = peer.requests.find((r) => r.method === 'turn/start')!
    const input = (start.params as { input: Array<{ type: string; text?: string }> }).input
    expect(input).toEqual([
      { type: 'text', text: localCommandContext([shellContextText(exited(0), 'ok')]) },
      { type: 'text', text: 'and?' },
    ])
    expect(JSON.stringify(start.params)).not.toContain('"shell"')
    expect(shell.listeners()).toBe(0)
  })

  it('provider re-emits the row under one uuid, flushes only the text, and freezes a running shell into the snapshot', async () => {
    const model = new MockLanguageModelV3({ modelId: 'mock-1', doStream: streamText('ok') })
    const runner = new AiSdkRunner({ languageModel: model })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    await waitFor(() => runner.info().status === 'idle')
    const shell = fakeShell(running(), 'booting')
    runner.queueLocalCommand!(shell.source)

    const frozen = (runner.snapshot()!.state as { pendingLocalCommands?: string[] }).pendingLocalCommands!
    expect(frozen).toHaveLength(1)
    expect(frozen[0]).toContain('is still running as of the time this was written')
    expect(frozen[0]).toContain('booting')
    expect(runner.messages).toHaveLength(0)

    shell.set({ info: exited(0), text: 'ok' })
    expectOneRow(events)
    runner.sendMessage('and?')
    await waitFor(() => events.some((e) => e.type === 'turn_result'))
    const user = runner.messages.find((m) => m.role === 'user')!
    expect(blocksOf(user.content)).toEqual([
      { type: 'text', text: localCommandContext([shellContextText(exited(0), 'ok')]) },
      { type: 'text', text: 'and?' },
    ])
    expect(JSON.stringify(runner.messages)).not.toContain('"shell"')
    expect(runner.snapshot()!.state).not.toHaveProperty('pendingLocalCommands')
    expect(shell.listeners()).toBe(0)
  })
})
