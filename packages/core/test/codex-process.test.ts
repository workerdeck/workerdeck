import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { JsonRpcError } from '../src/engines/codex/jsonrpc.ts'
import { USAGE_A, USAGE_B, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

describe('CodexRunner: process contract, usage and rate limits', () => {
  it('fails loudly when initialize rejects the experimentalApi capability', async () => {
    const peer = scriptedPeer()
    peer.respond('initialize', () => {
      throw new JsonRpcError(-32602, 'unknown capability: experimentalApi')
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    const [result] = ofType(events, 'turn_result')
    expect(result).toMatchObject({ subtype: 'error_during_execution' })
    expect(result!.errors?.[0]).toMatch(/experimentalApi/)
    expect(result!.errors?.[0]).toMatch(/no non-experimental fallback/)
    expect(events.some((e) => e.type === 'session_error')).toBe(false)
    expect(runner.status).toBe('idle')
  })

  it('hands images to codex as localImage temp files and cleans up on close', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', connectFn: peer.connectFn })
    void runner.start()
    const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    runner.sendMessage('what is this?', [
      { id: 'att-1', name: 'pixel.png', mediaType: 'image/png', bytes: 68, data: pixel },
      {
        id: 'att-2',
        name: 'notes.txt',
        mediaType: 'text/plain',
        bytes: 5,
        data: Buffer.from('hello').toString('base64'),
      },
    ])
    await vi.waitFor(() => expect(peer.requests.some((r) => r.method === 'turn/start')).toBe(true))
    const input = (
      peer.requests.find((r) => r.method === 'turn/start')!.params as {
        input: Array<{ type: string; path?: string; text?: string }>
      }
    ).input
    const image = input.find((p) => p.type === 'localImage')!
    expect(image.path).toMatch(/att-1\.png$/)
    expect(existsSync(image.path!)).toBe(true)
    expect(readFileSync(image.path!).equals(Buffer.from(pixel, 'base64'))).toBe(true)
    const texts = input.filter((p) => p.type === 'text').map((p) => p.text)
    expect(texts[0]).toContain('<attachment name="notes.txt" type="text/plain">')
    expect(texts[1]).toBe('what is this?')

    // A delta across close(), not a total: a promptless session also opens a throwaway probe
    // connection. Snapshot and assert back to back — no await for that close to slip through.
    const closedBefore = peer.closed()
    runner.close()
    expect(existsSync(image.path!)).toBe(false)
    expect(peer.closed()).toBe(closedBefore + 1)

    const pdfPeer = scriptedPeer()
    const pdfRunner = new CodexRunner({ cwd: '/tmp', connectFn: pdfPeer.connectFn })
    void pdfRunner.start()
    expect(() =>
      pdfRunner.sendMessage('read this', [{ id: 'a', name: 'doc.pdf', mediaType: 'application/pdf', bytes: 4, data: 'JVBERg==' }]),
    ).toThrow(/unsupported attachment/)
  })

  it('passes a complete child env with the CODEX_HOME pin winning, on every spawn', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp',
      prompt: 'go',
      connectFn: peer.connectFn,
      env: { PATH: '/usr/bin', HOME: '/Users/op', CODEX_HOME: '/elsewhere', GONE: undefined },
      codexHome: '/profiles/codex-a',
    })
    await runner.start()
    expect(peer.envs[0]).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/op',
      CODEX_HOME: '/profiles/codex-a',
    })
  })

  it('reports codex identity and the token-streaming capability record on info()', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({
      cwd: '/tmp/w',
      prompt: 'hello world',
      connectFn: peer.connectFn,
    })
    await runner.start()
    const info = runner.info()
    expect(info.engine).toBe('codex')
    expect(info.capabilities?.streaming).toBe('token')
    expect(info.capabilities?.interactiveApprovals).toBe(true)
    expect(info.sdkSessionId).toBe('thread-1')
    expect(info.pendingPermissionCount).toBe(0)
    expect(info.title).toBe('hello world')
  })

  it('measures context occupancy from `last`, never the cumulative `total`', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: { last: USAGE_A, total: USAGE_A, modelContextWindow: 1000 },
      })
      emit('thread/tokenUsage/updated', {
        threadId: 'thread-1',
        turnId,
        tokenUsage: {
          last: USAGE_B,
          total: { ...USAGE_A, totalTokens: USAGE_A.totalTokens + USAGE_B.totalTokens },
          modelContextWindow: 1000,
        },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp/w', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const [usage] = ofType(events, 'context_usage')
    expect(usage).toBeDefined()
    expect(usage!.usage.totalTokens).toBe(USAGE_B.totalTokens)
    expect(usage!.usage.maxTokens).toBe(1000)
    expect(usage!.usage.percentage).toBeCloseTo(45)
    expect(usage!.usage.categories).toEqual([])
    const [result] = ofType(events, 'turn_result')
    expect(result!.usage).toMatchObject({
      output_tokens: USAGE_A.outputTokens + USAGE_A.reasoningOutputTokens + USAGE_B.outputTokens + USAGE_B.reasoningOutputTokens,
    })
  })

  it('names codex rate-limit windows by their measured duration, and plans once', async () => {
    const peer = scriptedPeer()
    scriptTurn(peer, (emit, turnId) => {
      emit('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_786_518_770 },
          secondary: { usedPercent: 43, windowDurationMins: 10_080, resetsAt: 1_786_600_000 },
          planType: 'plus',
          rateLimitReachedType: null,
        },
      })
      emit('account/rateLimits/updated', {
        rateLimits: {
          primary: { usedPercent: 90, windowDurationMins: 43_200 },
          secondary: { usedPercent: null, windowDurationMins: 10_080 },
          planType: 'plus',
          rateLimitReachedType: 'primary',
        },
      })
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp/w', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()

    const limits = ofType(events, 'rate_limit').map((e) => e.info)
    expect(limits[0]).toMatchObject({
      status: 'allowed',
      rateLimitType: 'five_hour',
      utilization: 12,
      resetsAt: 1_786_518_770,
    })
    expect(limits[1]).toMatchObject({ rateLimitType: 'seven_day', utilization: 43 })
    expect(limits[2]).toMatchObject({
      status: 'rejected',
      rateLimitType: 'window_43200m',
      utilization: 90,
    })
    expect(limits[2]!.resetsAt).toBeUndefined()
    expect(limits).toHaveLength(3)

    const plans = ofType(events, 'plan_info')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.subscriptionType).toBe('plus')
  })

  it('refuses forkSession and CLI-only permission modes at construction', () => {
    const peer = scriptedPeer()
    expect(() => new CodexRunner({ cwd: '/tmp', resume: 't', forkSession: true, connectFn: peer.connectFn })).toThrow(/fork/)
    expect(() => new CodexRunner({ cwd: '/tmp', permissionMode: 'plan', connectFn: peer.connectFn })).toThrow(/not supported/)
  })

  it('fails the turn when turn/start itself is rejected, and stays usable', async () => {
    const peer = scriptedPeer()
    let attempts = 0
    peer.respond('turn/start', () => {
      if (++attempts === 1) {
        throw new Error('invalid params: input')
      }
      peer.emit('turn/completed', { threadId: 'thread-1', turn: { id: 't2', status: 'completed' } })
      return { turn: { id: 't2', status: 'inProgress' } }
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'go', connectFn: peer.connectFn })
    const events = collect(runner)
    await runner.start()
    expect(ofType(events, 'turn_result')[0]).toMatchObject({
      subtype: 'error_during_execution',
      errors: ['invalid params: input'],
    })
    runner.sendMessage('again')
    await vi.waitFor(() => expect(ofType(events, 'turn_result')).toHaveLength(2))
    expect(ofType(events, 'turn_result')[1]).toMatchObject({ subtype: 'success' })
  })
})
