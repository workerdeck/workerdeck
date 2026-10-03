import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEventBody } from '@workerdeck/protocol'
import { SessionRunner } from '../src/index.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { ToolOutputTails, TOOL_OUTPUT_TAIL_LINES, toolOutputTail } from '../src/lib/tool-output.ts'
import { findTaskOutput, tailTaskOutput, taskOutputRoots } from '../src/engines/claude/task-output.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wd-tool-output-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
const claudeDir = uid === undefined ? 'claude' : `claude-${uid}`

describe('toolOutputTail', () => {
  it('keeps the last lines, strips colour and shows only the last redraw of a progress line', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    expect(toolOutputTail(lines).split('\n')).toHaveLength(TOOL_OUTPUT_TAIL_LINES)
    expect(toolOutputTail(lines).split('\n').at(-1)).toBe('line 29')
    expect(toolOutputTail('\x1b[32mok\x1b[0m\ndownloading 10%\rdownloading 55%\n')).toBe('ok\ndownloading 55%')
  })
})

describe('ToolOutputTails', () => {
  it('flushes a coalesced whole tail per tool and stops at the tool result', () => {
    vi.useFakeTimers()
    const out: SessionEventBody[] = []
    const tails = new ToolOutputTails((body) => out.push(body), 100)
    tails.append('t1', 'one\n')
    tails.append('t1', 'two\n')
    expect(out).toEqual([])
    vi.advanceTimersByTime(100)
    expect(out).toEqual([{ type: 'tool_output', toolUseId: 't1', tail: 'one\ntwo' }])
    tails.append('t1', 'three\n')
    tails.observe({
      type: 'user_message',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      parentToolUseId: null,
    } as SessionEventBody)
    vi.advanceTimersByTime(100)
    expect(out).toHaveLength(1)
    expect(tails.has('t1')).toBe(false)
  })

  it('runs the stop hook when the turn ends', () => {
    const stop = vi.fn()
    const tails = new ToolOutputTails(() => {})
    tails.track('t1', stop)
    tails.observe({ type: 'status_changed', status: 'awaiting_approval' })
    expect(stop).not.toHaveBeenCalled()
    tails.observe({ type: 'status_changed', status: 'idle' })
    expect(stop).toHaveBeenCalledOnce()
  })
})

describe('claude task output files', () => {
  it('finds the task file under any cwd slug and tails what the CLI appends', async () => {
    const base = tempDir()
    const tasks = join(base, claudeDir, '-some-cwd', 'sess-1', 'tasks')
    mkdirSync(tasks, { recursive: true })
    const file = join(tasks, 'b-1.output')
    writeFileSync(file, 'first\n')
    const roots = taskOutputRoots({ CLAUDE_CODE_TMPDIR: base })
    expect(findTaskOutput(roots, 'sess-1', 'b-1')).toBe(file)
    expect(findTaskOutput(roots, 'sess-1', 'nope')).toBeUndefined()

    const out: SessionEventBody[] = []
    const tails = new ToolOutputTails((body) => out.push(body), 10)
    tailTaskOutput(tails, { toolUseId: 'bash-1', taskId: 'b-1', sessionId: 'sess-1', roots, pollMs: 10 })
    await wait(40)
    appendFileSync(file, 'second\n')
    await wait(60)
    expect(out.at(-1)).toEqual({ type: 'tool_output', toolUseId: 'bash-1', tail: 'first\nsecond' })
    tails.end('bash-1')
    appendFileSync(file, 'third\n')
    await wait(60)
    expect(out.at(-1)).toEqual({ type: 'tool_output', toolUseId: 'bash-1', tail: 'first\nsecond' })
  })
})

const init = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Bash'],
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

describe('SessionRunner live Bash output and backgrounding', () => {
  it('streams a foreground Bash task file as tool_output until the result lands', async () => {
    const base = tempDir()
    const tasks = join(base, claudeDir, '-tmp-project', 'sdk-session-1', 'tasks')
    mkdirSync(tasks, { recursive: true })
    writeFileSync(join(tasks, 'b-1.output'), 'Downloading torch\n')
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn, env: { CLAUDE_CODE_TMPDIR: base } })
    const events: SessionEventBody[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    harness.emit(init)
    harness.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b-1',
      tool_use_id: 'bash-1',
      description: 'uv sync',
      task_type: 'local_bash',
      is_backgrounded: false,
      uuid: 'u-1',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    await wait(1000)
    expect(events.filter((e) => e.type === 'tool_output')).toMatchObject([
      { type: 'tool_output', toolUseId: 'bash-1', tail: 'Downloading torch' },
    ])
    harness.emit({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok' }] },
      parent_tool_use_id: null,
      uuid: 'u-2',
      session_id: 'sdk-session-1',
    } as unknown as SDKMessage)
    await tick()
    appendFileSync(join(tasks, 'b-1.output'), 'more\n')
    await wait(1000)
    expect(events.filter((e) => e.type === 'tool_output')).toHaveLength(1)
    runner.close()
  })

  it('moves a task to the background through the SDK', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn })
    expect(await runner.backgroundTask('bash-1')).toBe(false)
    void runner.start()
    harness.emit(init)
    await tick()
    expect(await runner.backgroundTask('bash-1')).toBe(true)
    expect(harness.backgroundTasks).toHaveBeenCalledWith('bash-1')
    expect(await runner.backgroundTask('unknown')).toBe(false)
    expect(await runner.backgroundTask()).toBe(true)
    runner.close()
  })
})

describe('CodexRunner live command output', () => {
  it('maps commandExecution output deltas to a tool_output tail on the command row', async () => {
    const on = scriptedPeer()
    scriptTurn(on, (emit, turnId) => {
      const item = { id: 'exec-1', type: 'commandExecution', command: 'uv sync', status: 'inProgress' }
      emit('item/started', { threadId: 'thread-1', turnId, item })
      emit('item/commandExecution/outputDelta', { threadId: 'thread-1', turnId, itemId: 'exec-1', delta: 'Resolved 212 packages\n' })
      emit('item/commandExecution/outputDelta', { threadId: 'thread-1', turnId, itemId: 'exec-1', delta: 'Downloading torch\n' })
      setTimeout(() => {
        emit('item/completed', {
          threadId: 'thread-1',
          turnId,
          item: { ...item, status: 'completed', exitCode: 0, aggregatedOutput: 'done' },
        })
        emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
      }, 600)
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: on.connectFn })
    const events = collect(runner)
    await runner.start()
    await wait(700)
    const outputs = ofType(events, 'tool_output')
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.tail).toBe('Resolved 212 packages\nDownloading torch')
    const toolUse = ofType(events, 'assistant_message')
      .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
      .find((block) => block.type === 'tool_use') as { id: string } | undefined
    expect(outputs[0]!.toolUseId).toBe(toolUse?.id)
    runner.close()
  })
})
