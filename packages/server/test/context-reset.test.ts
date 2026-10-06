import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClearContextOptions, Runner } from '@workerdeck/core'
import type { SessionEvent, SessionEventBody, SessionInfo, SessionStatus } from '@workerdeck/protocol'
import { CONTEXT_RESET_SCHEDULED, ContextResetService } from '../src/services/context-resets.ts'
import { fakeHarness } from './helpers.ts'
import { attachSocket, createSession, get, shellFixture } from './shell-helpers.ts'

const REQUEST = { prompt: 'continue from @NEXT.md', reason: 'context at 80%' }

type ScriptedRunner = Runner & {
  emit(body: SessionEventBody): void
  cleared: ClearContextOptions[]
  sent: string[]
}

function scriptedRunner(id: string, enabled = true): ScriptedRunner {
  const listeners = new Set<(event: SessionEvent) => void>()
  let seq = 0
  let status: SessionStatus = 'running'
  const runner: ScriptedRunner = {
    id,
    cleared: [],
    sent: [],
    pendingApprovals: [],
    start: async () => {},
    info: (): SessionInfo => ({
      id,
      status,
      cwd: '/tmp',
      createdAt: 0,
      lastSeq: seq,
      pendingPermissionCount: 0,
      ...(enabled ? { agentContextReset: true as const } : {}),
    }),
    emit(body) {
      if (body.type === 'status_changed') {
        status = body.status
      }
      const event = { ...body, seq: ++seq, ts: Date.now() } as SessionEvent
      for (const listener of listeners) {
        listener(event)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sendMessage(text) {
      runner.sent.push(text)
    },
    async clearContext(options) {
      runner.cleared.push(options ?? {})
      queueMicrotask(() =>
        runner.emit({ type: 'conversation_reset', ...(options?.agentReason ? { agentReason: options.agentReason } : {}) }),
      )
    },
    setTitle: () => {},
    resolvePermission: () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    fail: () => {},
    close: () => {},
  }
  return runner
}

function turnResult(isError: boolean): SessionEventBody {
  return {
    type: 'turn_result',
    subtype: isError ? 'error_during_execution' : 'success',
    isError,
    durationMs: 1,
    numTurns: 1,
    totalCostUsd: 0,
  }
}

describe('ContextResetService', () => {
  it('holds a reset until the turn ends, then clears with the reason and sends the prompt', async () => {
    const service = new ContextResetService()
    const runner = scriptedRunner('s1')
    service.watch(runner)

    await expect(service.request('s1', REQUEST)).resolves.toBe(CONTEXT_RESET_SCHEDULED)
    expect(runner.cleared).toEqual([])

    runner.emit(turnResult(false))
    runner.emit({ type: 'status_changed', status: 'idle' })
    await vi.waitFor(() => expect(runner.sent).toEqual([REQUEST.prompt]))
    expect(runner.cleared).toEqual([{ agentReason: REQUEST.reason }])
  })

  it('refuses a session that was not given the tool, and a second reset while one is scheduled', async () => {
    const service = new ContextResetService()
    service.watch(scriptedRunner('off', false))
    await expect(service.request('off', REQUEST)).rejects.toThrow(/not enabled/)
    await expect(service.request('unknown', REQUEST)).rejects.toThrow(/not enabled/)

    service.watch(scriptedRunner('s1'))
    await service.request('s1', REQUEST)
    await expect(service.request('s1', REQUEST)).rejects.toThrow(/already scheduled/)
  })

  it('cancels the reset when the turn ends in an error, an interrupt included', async () => {
    const service = new ContextResetService()
    const runner = scriptedRunner('s1')
    service.watch(runner)
    await service.request('s1', REQUEST)

    runner.emit(turnResult(true))
    runner.emit({ type: 'status_changed', status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runner.cleared).toEqual([])
    await expect(service.request('s1', REQUEST)).resolves.toBe(CONTEXT_RESET_SCHEDULED)
  })

  it('rate-limits by the minimum interval and by the hourly cap', async () => {
    let now = 1_000_000
    const service = new ContextResetService({ minIntervalMs: 5 * 60_000, maxPerHour: 2, now: () => now })
    const runner = scriptedRunner('s1')
    service.watch(runner)
    const resetOnce = async (): Promise<void> => {
      await service.request('s1', REQUEST)
      const sent = runner.sent.length
      runner.emit({ type: 'status_changed', status: 'idle' })
      await vi.waitFor(() => expect(runner.sent.length).toBe(sent + 1))
    }

    await resetOnce()
    now += 60_000
    await expect(service.request('s1', REQUEST)).rejects.toThrow(/last reset was 1 minute ago.*5 minutes between/)
    now += 5 * 60_000
    await resetOnce()
    now += 6 * 60_000
    await expect(service.request('s1', REQUEST)).rejects.toThrow(/2 time\(s\) in the last hour \(limit 2\)/)
    now += 60 * 60_000
    await expect(service.request('s1', REQUEST)).resolves.toBe(CONTEXT_RESET_SCHEDULED)
  })

  it('drops the scheduled reset when the session closes or the watcher detaches', async () => {
    const service = new ContextResetService()
    const runner = scriptedRunner('s1')
    const detach = service.watch(runner)!
    await service.request('s1', REQUEST)
    runner.emit({ type: 'session_closed', reason: 'server' })
    runner.emit({ type: 'status_changed', status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runner.cleared).toEqual([])

    await service.request('s1', REQUEST)
    detach()
    runner.emit({ type: 'status_changed', status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(runner.cleared).toEqual([])
  })
})

const INIT = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp',
  tools: [],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  uuid: 'u-init',
} as unknown as SDKMessage

const RESULT = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1,
  duration_api_ms: 1,
  is_error: false,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  total_cost_usd: 0,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'u-r',
  session_id: 'sdk-1',
} as unknown as SDKMessage

type ToolHandler = (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>

function gatewayTools(harness: ReturnType<typeof fakeHarness>): Record<string, { handler: ToolHandler }> {
  const servers = (harness.captured.options?.mcpServers ?? {}) as Record<string, { instance: unknown }>
  const instance = servers.workerdeck?.instance as Record<string, Record<string, { handler: ToolHandler }>> | undefined
  return instance?.['_registeredTools'] ?? {}
}

function inputTexts(harness: ReturnType<typeof fakeHarness>): string[] {
  return harness.captured.inputs.map((input) => input.message.content as string)
}

async function info(base: string, id: string): Promise<SessionInfo> {
  return ((await (await get(base, `/sessions/${id}`)).json()) as { session: SessionInfo }).session
}

describe('context_reset through the gateway', () => {
  const fx = shellFixture('wd-context-reset-')
  afterEach(fx.cleanup)

  it('offers the tool only where the request, the profile default or the gateway default turns it on', async () => {
    const off = fakeHarness()
    const { base } = await fx.startServer(off)
    const plain = await createSession(base, 'operator', { cwd: fx.tempDir(), prompt: 'hi' })
    await vi.waitFor(() => expect(off.captured.options).toBeDefined())
    expect(Object.keys(gatewayTools(off))).not.toContain('context_reset')
    expect((await info(base, plain)).agentContextReset).toBeUndefined()
    await fx.cleanup()

    const asked = fakeHarness()
    const { base: askedBase } = await fx.startServer(asked)
    const id = await createSession(askedBase, 'operator', { cwd: fx.tempDir(), prompt: 'hi', agentContextReset: true })
    await vi.waitFor(() => expect(asked.captured.options).toBeDefined())
    expect(Object.keys(gatewayTools(asked)).slice(0, 3)).toEqual(['session_info', 'set_status', 'context_reset'])
    expect((await info(askedBase, id)).agentContextReset).toBe(true)
    await fx.cleanup()

    const forbidden = fakeHarness()
    const { base: forbiddenBase } = await fx.startServer(forbidden, { agentContextReset: false })
    await createSession(forbiddenBase, 'operator', { cwd: fx.tempDir(), prompt: 'hi', agentContextReset: true })
    await vi.waitFor(() => expect(forbidden.captured.options).toBeDefined())
    expect(Object.keys(gatewayTools(forbidden))).not.toContain('context_reset')
    await fx.cleanup()

    const byDefault = fakeHarness()
    const { base: defaultBase } = await fx.startServer(byDefault, { agentContextReset: { default: true } })
    await createSession(defaultBase, 'operator', { cwd: fx.tempDir(), prompt: 'hi', agentContextReset: false })
    await vi.waitFor(() => expect(byDefault.captured.options).toBeDefined())
    expect(Object.keys(gatewayTools(byDefault))).not.toContain('context_reset')
  })

  it('clears the claude conversation after the turn, stamps the reason on the reset, then sends the prompt', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await fx.startServer(harness, { agentContextReset: { default: true } })
    const id = await createSession(base, 'operator', { cwd: fx.tempDir(), prompt: 'work' })
    await vi.waitFor(() => expect(harness.captured.options).toBeDefined())
    const { ws, collector } = await attachSocket(wsBase, id, 'operator')
    harness.emit(INIT)

    const result = await gatewayTools(harness).context_reset!.handler(REQUEST, {})
    expect(result.isError).toBeFalsy()
    expect(result.content[0]!.text).toBe(CONTEXT_RESET_SCHEDULED)
    expect(inputTexts(harness)).toEqual(['work'])

    harness.emit(RESULT)
    await vi.waitFor(() => expect(inputTexts(harness)).toEqual(['work', '/clear']))
    harness.emit({ type: 'conversation_reset', new_conversation_id: 'sdk-2' } as unknown as SDKMessage)
    await vi.waitFor(() => expect(inputTexts(harness)).toEqual(['work', '/clear', REQUEST.prompt]))

    const reset = await collector.waitFor((frame) => frame.type === 'event' && frame.event.type === 'conversation_reset')
    expect(reset).toMatchObject({ event: { agentReason: REQUEST.reason, sdkSessionId: 'sdk-2' } })
    ws.close()
  })
})
