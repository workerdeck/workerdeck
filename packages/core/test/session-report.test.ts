import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent, SessionInfo } from '@workerdeck/protocol'
import { CodexRunner, SessionRunner, buildSessionReport } from '../src/index.ts'
import { resolveContextWindow, stepContextTokens } from '../src/engines/provider/turn.ts'
import { fakeHarness, tick } from './helpers/claude-harness.ts'
import { scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

const NOW = Date.parse('2026-10-03T12:00:00Z')

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: [],
  mcp_servers: [],
  permissionMode: 'default',
  apiKeySource: 'user',
  uuid: 'uuid-init',
} as unknown as SDKMessage

function info(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    status: 'running',
    cwd: '/repo',
    createdAt: NOW - 60_000,
    engine: 'claude',
    model: 'claude-test-1',
    numTurns: 4,
    costUsd: 1.234567,
    ...overrides,
  } as SessionInfo
}

function rateLimit(seq: number, ts: number, type: string, utilization: number, resetsAt?: number): SessionEvent {
  return { seq, ts, type: 'rate_limit', info: { status: 'allowed', rateLimitType: type, utilization, ...(resetsAt ? { resetsAt } : {}) } }
}

describe('buildSessionReport', () => {
  it('derives percent and remaining tokens from the window', () => {
    const report = buildSessionReport({
      info: info(),
      vendor: 'anthropic',
      context: { totalTokens: 50_000, maxTokens: 200_000, measured: 'live' },
      events: [],
      rateLimitsSupported: true,
      now: NOW,
    })
    expect(report).toMatchObject({
      engine: 'claude',
      vendor: 'anthropic',
      model: 'claude-test-1',
      turns: 4,
      cost: { usd: 1.2346, basis: 'list_price_estimate' },
      context: { usedTokens: 50_000, maxTokens: 200_000, percent: 25, remainingTokens: 150_000, measured: 'live' },
      rateLimits: [],
      notes: ['No rate-limit reading yet; one arrives after the first turn.'],
    })
  })

  it('keeps used tokens and says why when the window is unknown', () => {
    const report = buildSessionReport({
      info: info({ engine: 'provider', costUsd: undefined }),
      vendor: 'openai',
      context: { totalTokens: 9_000, measured: 'last_turn' },
      contextNote: 'unknown window',
      events: [],
      rateLimitsSupported: false,
      now: NOW,
    })
    expect(report.context).toEqual({
      usedTokens: 9_000,
      maxTokens: null,
      percent: null,
      remainingTokens: null,
      measured: 'last_turn',
      note: 'unknown window',
    })
    expect(report.rateLimits).toBeNull()
    expect(report.cost).toEqual({ usd: null, basis: 'unpriced' })
  })

  it('reports the latest reading per window, zeroes a window past its reset and flags a stale one', () => {
    const resetSoon = NOW / 1000 + 3600
    const events = [
      rateLimit(1, NOW - 60 * 60_000, 'five_hour', 10, NOW / 1000 - 10),
      rateLimit(2, NOW - 60_000, 'seven_day', 40, resetSoon),
      rateLimit(3, NOW - 60 * 60_000, 'seven_day_opus', 90),
      rateLimit(4, NOW - 30_000, 'seven_day', 42, resetSoon),
    ]
    const report = buildSessionReport({
      info: info(),
      vendor: 'anthropic',
      context: undefined,
      events,
      rateLimitsSupported: true,
      now: NOW,
    })
    expect(report.context).toBeNull()
    expect(report.rateLimits).toEqual([
      expect.objectContaining({ window: 'five_hour', usedPercent: 0, stale: true }),
      expect.objectContaining({ window: 'seven_day', usedPercent: 42, stale: false, resetsAt: new Date(resetSoon * 1000).toISOString() }),
      expect.objectContaining({ window: 'seven_day_opus', usedPercent: 90, resetsAt: null, stale: true }),
    ])
  })
})

describe('provider context helpers', () => {
  it('counts the last step prompt plus its output, and nothing without a prompt count', () => {
    expect(stepContextTokens({ inputTokens: 1000, outputTokens: 200 } as never)).toBe(1200)
    expect(stepContextTokens({ inputTokens: undefined, outputTokens: 200 } as never)).toBeUndefined()
  })

  it('resolves a window from a number or a per-model map, first matching model wins', () => {
    expect(resolveContextWindow(128_000, 'any')).toBe(128_000)
    expect(resolveContextWindow({ 'gpt-x': 400_000 }, 'gpt-x-2026', 'gpt-x')).toBe(400_000)
    expect(resolveContextWindow({ 'gpt-x': 400_000 }, 'other')).toBeUndefined()
    expect(resolveContextWindow(undefined, 'gpt-x')).toBeUndefined()
    expect(resolveContextWindow(0, 'gpt-x')).toBeUndefined()
  })
})

describe('session_info on the engines', () => {
  it('claude: always registered, and answers with a live context reading and the account windows', async () => {
    const harness = fakeHarness({
      contextUsage: {
        categories: [{ name: 'Messages', tokens: 60_000, color: '#0aa' }],
        totalTokens: 80_000,
        maxTokens: 200_000,
        percentage: 40,
        model: 'claude-test-1',
      },
      usage: {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 37, resets_at: new Date(Date.now() + 3_600_000).toISOString() } },
      },
    })
    const runner = new SessionRunner({ cwd: '/tmp/p', queryFn: harness.queryFn })
    void runner.start()
    harness.emit(initMessage)
    await tick()
    const servers = harness.captured.options!.mcpServers as Record<string, { instance: unknown }>
    const instance = servers.workerdeck!.instance as Record<
      string,
      Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>
    >
    const tools = instance['_registeredTools']!
    const result = (await tools.session_info!.handler({}, {})) as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(false)
    const report = JSON.parse(result.content[0]!.text)
    expect(report).toMatchObject({
      session: { id: runner.id },
      engine: 'claude',
      vendor: 'anthropic',
      model: 'claude-test-1',
      context: {
        usedTokens: 80_000,
        maxTokens: 200_000,
        percent: 40,
        measured: 'live',
        categories: [{ name: 'Messages', tokens: 60_000 }],
      },
      rateLimits: [expect.objectContaining({ window: 'five_hour', usedPercent: 37 })],
    })
  })

  it('codex: answers item/tool/call for session_info with no directory configured', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, () => {})
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn })
    void runner.start()
    await vi.waitFor(() => expect(peer.requests.some((r) => r.method === 'thread/start')).toBe(true))
    const answer = (await peer.serverRequest('item/tool/call', {
      callId: 'c',
      threadId: 't',
      turnId: 'u',
      tool: 'session_info',
      arguments: {},
    })) as { success: boolean; contentItems: Array<{ text: string }> }
    expect(answer.success).toBe(true)
    expect(JSON.parse(answer.contentItems[0]!.text)).toMatchObject({ session: { id: runner.id }, engine: 'codex', vendor: 'openai' })
  })
})
