import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ProfileInfo, SessionEvent } from '@workerdeck/protocol'
import { SessionRunner } from '../src/engines/claude/runner.ts'
import type { ToolExecutor } from '../src/executors/tool-executor.ts'
import { claudeAdapter } from '../src/engines/claude/adapter.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { createEngineSession } from '../src/engines/provider/session.ts'
import { composeInstructions, resolveInstructions } from '../src/lib/instructions.ts'
import { ancestorInstructionExcludes, foreignHomeExcludes, withInstructionExcludes } from '../src/engines/claude/instruction-scope.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { scriptTurn, scriptedPeer, THREAD_RESULT } from './helpers/codex-peer.ts'
import { streamText } from './helpers/ai-sdk-mocks.ts'
import { eventually } from './helpers/wait.ts'

const CONTEXT = { sessionId: 'session-1' }

function presetAppend(options: Options | undefined): string | undefined {
  const prompt = options?.systemPrompt
  return typeof prompt === 'object' && !Array.isArray(prompt) && prompt.type === 'preset' ? prompt.append : undefined
}

function profileWith(instructions: string): ProfileInfo {
  return { name: 'builder', engine: 'claude', session: { instructions } }
}

describe('instructions composition', () => {
  it('joins a profile string and a session string with a blank line', () => {
    expect(composeInstructions('profile text', 'session text')).toBe('profile text\n\nsession text')
  })

  it('keeps a lone part as-is and drops empty ones', () => {
    expect(composeInstructions(undefined, 'only')).toBe('only')
    expect(composeInstructions('', undefined)).toBeUndefined()
  })

  it('composes a resolver by resolving every part against the same context', () => {
    const composed = composeInstructions('profile text', (context) => `session ${context.sessionId}`)
    expect(resolveInstructions(composed, CONTEXT)).toBe('profile text\n\nsession session-1')
  })

  it('treats whitespace-only text as absent', () => {
    expect(resolveInstructions('   \n ', CONTEXT)).toBeUndefined()
  })
})

describe('SessionRunner instructions', () => {
  it('appends to the claude_code preset rather than replacing the system prompt', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn, instructions: 'be a builder' })
    void runner.start()
    await tick()
    expect(harness.captured.options?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'be a builder' })
  })

  it('resolves a function against the runner id the caller assigned', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner(
      {
        cwd: '/tmp/project',
        profile: 'builder',
        queryFn: harness.queryFn,
        instructions: (c) => `session ${c.sessionId} in ${c.cwd} on ${c.profile}`,
      },
      'runner-42',
    )
    void runner.start()
    await tick()
    expect(runner.id).toBe('runner-42')
    expect(presetAppend(harness.captured.options)).toBe('session runner-42 in /tmp/project on builder')
  })

  it('never writes the instruction into the transcript', async () => {
    const harness = fakeHarness()
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn: harness.queryFn, instructions: 'secret builder context' })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    await tick()
    runner.sendMessage('hello')
    await tick()
    expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1)
    expect(JSON.stringify(events)).not.toContain('secret builder context')
    expect(harness.captured.inputs.map((input) => JSON.stringify(input.message.content)).join()).not.toContain('secret builder context')
  })

  it('survives /clear, which runs on the same query', async () => {
    const harness = fakeHarness()
    let queries = 0
    const queryFn = (params: Parameters<typeof harness.queryFn>[0]) => {
      queries += 1
      return harness.queryFn(params)
    }
    const runner = new SessionRunner({ cwd: '/tmp/project', queryFn, instructions: 'be a builder' })
    void runner.start()
    await tick()
    await runner.clearContext()
    await tick()
    expect(queries).toBe(1)
    expect(presetAppend(harness.captured.options)).toBe('be a builder')
  })

  it('refuses to guess when the host also set extraOptions.systemPrompt', () => {
    const harness = fakeHarness()
    expect(
      () =>
        new SessionRunner({
          cwd: '/tmp/project',
          queryFn: harness.queryFn,
          instructions: 'be a builder',
          extraOptions: { systemPrompt: 'you are a release bot' },
        }),
    ).toThrow(/both set/)
  })

  it('puts the profile instructions before the session ones', async () => {
    const harness = fakeHarness()
    const runner = (await claudeAdapter.createRunner({
      config: { cwd: '/tmp/project', queryFn: harness.queryFn, instructions: 'session text' },
      profile: profileWith('profile text'),
    })) as SessionRunner
    void runner.start()
    await tick()
    expect(presetAppend(harness.captured.options)).toBe('profile text\n\nsession text')
  })
})

describe('instruction scope', () => {
  it('excludes every ancestor instruction file but keeps the cwd and the user memory', () => {
    const patterns = ancestorInstructionExcludes('/home/me/repo/packages/db', { home: '/home/me' })
    expect(patterns).toContain('/home/me/repo/AGENTS.md')
    expect(patterns).toContain('/home/me/repo/.claude/rules/**')
    expect(patterns).toContain('/home/me/CLAUDE.md')
    expect(patterns).toContain('/CLAUDE.md')
    expect(patterns).not.toContain('/home/me/.claude/CLAUDE.md')
    expect(patterns).not.toContain('/home/me/.claude/rules/**')
    expect(patterns.some((pattern) => pattern.startsWith('/home/me/repo/packages/db/'))).toBe(false)
  })

  it("treats ~/.claude as a foreign project folder when the CLI's config dir is elsewhere", () => {
    const profile = { home: '/home/me', configDir: '/home/me/.workerdeck/profiles/work' }
    expect(foreignHomeExcludes({ home: '/home/me', configDir: '/home/me/.claude' })).toEqual([])
    expect(foreignHomeExcludes({ home: '/home/me' })).toEqual([])
    expect(foreignHomeExcludes(profile)).toEqual(['/home/me/.claude/CLAUDE.md', '/home/me/.claude/AGENTS.md', '/home/me/.claude/rules/**'])
    expect(ancestorInstructionExcludes('/home/me/repo/pkg', profile)).toContain('/home/me/.claude/CLAUDE.md')
  })

  it('escapes glob characters in directory names', () => {
    expect(ancestorInstructionExcludes('/work/app (old)/pkg', { home: '/home/me' })).toContain('/work/app [(]old[)]/AGENTS.md')
  })

  it('merges into host settings rather than replacing them', () => {
    expect(withInstructionExcludes({ claudeMdExcludes: ['/a'], model: 'x' }, ['/b'])).toEqual({
      claudeMdExcludes: ['/a', '/b'],
      model: 'x',
    })
    expect(withInstructionExcludes('{"claudeMdExcludes":["/a"]}', ['/b'])).toEqual({ claudeMdExcludes: ['/a', '/b'] })
    expect(() => withInstructionExcludes('/etc/settings.json', ['/b'])).toThrow(/settings file path/)
  })

  it('passes the excludes to the Claude engine only when the scope is cwd', async () => {
    const scoped = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/project/pkg', queryFn: scoped.queryFn, instructionScope: 'cwd' }).start()
    const plain = fakeHarness()
    void new SessionRunner({ cwd: '/tmp/project/pkg', queryFn: plain.queryFn }).start()
    await tick()
    const settings = scoped.captured.options?.settings
    expect(typeof settings === 'object' ? settings.claudeMdExcludes : undefined).toContain('/tmp/project/AGENTS.md')
    expect(plain.captured.options?.settings).toBeUndefined()
  })

  it('makes the cwd the codex project root when the scope is cwd', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, instructionScope: 'cwd' })
    await runner.start()
    const starts = () => peer.requests.filter((request) => request.method === 'thread/start')
    await eventually(() => expect(starts()).toHaveLength(1))
    expect((starts()[0]!.params as { config?: Record<string, unknown> }).config).toMatchObject({ project_root_markers: [] })
  })
})

describe('CodexRunner instructions', () => {
  const threadOptions = (peer: ReturnType<typeof scriptedPeer>, method: string) =>
    peer.requests.filter((request) => request.method === method).map((request) => request.params as { developerInstructions?: string })

  it('sends developerInstructions on thread/start', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }))
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, instructions: 'be a builder' })
    await runner.start()
    await eventually(() => expect(threadOptions(peer, 'thread/start')).toHaveLength(1))
    expect(threadOptions(peer, 'thread/start')[0]!.developerInstructions).toBe('be a builder')
  })

  it('sends them on thread/resume too', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } }))
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'hi',
      connectFn: peer.connectFn,
      resume: 'thread-1',
      instructions: 'be a builder',
    })
    await runner.start()
    await eventually(() => expect(threadOptions(peer, 'thread/resume')).toHaveLength(1))
    expect(threadOptions(peer, 'thread/resume')[0]!.developerInstructions).toBe('be a builder')
  })

  it('carries them onto the fresh thread a clear creates', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    peer.respond('turn/start', (params) => {
      const threadId = (params as { threadId: string }).threadId
      peer.emit('turn/started', { threadId, turn: { id: 'turn-1', status: 'inProgress' } })
      peer.emit('turn/completed', { threadId, turn: { id: 'turn-1', status: 'completed' } })
      return { turn: { id: 'turn-1', status: 'inProgress' } }
    })
    const runner = new CodexRunner(
      { cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, instructions: (c) => `session ${c.sessionId}` },
      'runner-7',
    )
    await runner.start()
    await runner.clearContext()
    const starts = threadOptions(peer, 'thread/start')
    expect(starts).toHaveLength(2)
    expect(starts.map((options) => options.developerInstructions)).toEqual(['session runner-7', 'session runner-7'])
  })
})

describe('AiSdkRunner instructions', () => {
  const settledExecutor: ToolExecutor = {
    dispatch: async (call) => ({ executionId: call.executionId, status: 'settled', result: { status: 'ok', output: null } }),
  }

  function systemCapture() {
    const seen: string[] = []
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: async ({ prompt }) => {
        const system = prompt.filter((message) => message.role === 'system').map((message) => message.content)
        seen.push(system.join('\n'))
        return streamText('ok')
      },
    })
    return { model, seen }
  }

  it('composes profile, host default and per-session instructions in that order', async () => {
    const { model, seen } = systemCapture()
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model, instructions: 'session text' },
      profile: { name: 'sandboxed', engine: 'provider', session: { instructions: 'profile text' } },
      instructions: 'host default',
      resolveModel: () => model,
      selectExecutor: () => settledExecutor,
    })
    void runner.start()
    runner.sendMessage('one')
    await eventually(() => expect(seen).toHaveLength(1), { timeout: 15_000 })
    expect(seen[0]).toBe('profile text\n\nhost default\n\nsession text')
    runner.close()
  }, 30_000)

  it('composes the profile instructions ahead of the host ones and keeps them across a clear', async () => {
    const { model, seen } = systemCapture()
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model, instructions: 'session text' },
      profile: { name: 'sandboxed', engine: 'provider', session: { instructions: 'profile text' } },
      resolveModel: () => model,
      selectExecutor: () => settledExecutor,
    })
    void runner.start()
    runner.sendMessage('one')
    await eventually(() => expect(seen).toHaveLength(1), { timeout: 15_000 })
    await runner.clearContext()
    runner.sendMessage('two')
    await eventually(() => expect(seen).toHaveLength(2), { timeout: 15_000 })
    expect(seen).toEqual(['profile text\n\nsession text', 'profile text\n\nsession text'])
    runner.close()
  }, 30_000)
})
