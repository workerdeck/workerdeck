import { describe, expect, it } from 'vitest'
import { CONTEXT_RESET_PROMPT_MAX, type ContextResetDirectory, type ContextResetRequest } from '../src/lib/context-reset.ts'
import { runSessionTool, sessionToolSpecs } from '../src/lib/session-tools.ts'
import { CodexRunner } from '../src/engines/codex/runner.ts'
import { THREAD_RESULT, collect, ofType, scriptTurn, scriptedPeer } from './helpers/codex-peer.ts'

function recordingDirectory(): ContextResetDirectory & { calls: Array<{ from: string; request: ContextResetRequest }> } {
  const calls: Array<{ from: string; request: ContextResetRequest }> = []
  return {
    calls,
    request: async (from, request) => {
      calls.push({ from, request })
      return 'scheduled'
    },
  }
}

describe('context_reset tool', () => {
  it('is offered right after session_info, and only with a directory', () => {
    const reset = recordingDirectory()
    expect(sessionToolSpecs({ report: async () => ({}) as never, reset, write: false }).map((spec) => spec.name)).toEqual([
      'session_info',
      'context_reset',
    ])
    expect(sessionToolSpecs({ report: async () => ({}) as never, write: false }).map((spec) => spec.name)).toEqual(['session_info'])
  })

  it('hands a trimmed request to the directory as the calling session, and refuses an empty or oversized prompt', async () => {
    const reset = recordingDirectory()
    const ok = await runSessionTool({ reset, write: false }, 'me', 'context_reset', { prompt: '  go on  ', reason: 'full' })
    expect(ok).toEqual({ text: 'scheduled', isError: false })
    expect(reset.calls).toEqual([{ from: 'me', request: { prompt: 'go on', reason: 'full' } }])

    const empty = await runSessionTool({ reset, write: false }, 'me', 'context_reset', { prompt: ' ', reason: 'full' })
    expect(empty?.isError).toBe(true)
    const long = await runSessionTool({ reset, write: false }, 'me', 'context_reset', {
      prompt: 'x'.repeat(CONTEXT_RESET_PROMPT_MAX + 1),
      reason: 'full',
    })
    expect(long?.isError).toBe(true)
    expect(reset.calls).toHaveLength(1)
  })

  it('answers a refusal from the directory as a tool error', async () => {
    const reset: ContextResetDirectory = { request: async () => Promise.reject(new Error('refused: too soon')) }
    expect(await runSessionTool({ reset, write: false }, 'me', 'context_reset', { prompt: 'p', reason: 'r' })).toEqual({
      text: 'refused: too soon',
      isError: true,
    })
  })

  it('codex stamps the agent reason on its reset and reports the tool on its info', async () => {
    const peer = scriptedPeer()
    let threads = 0
    peer.respond('thread/start', () => ({ ...THREAD_RESULT, thread: { id: `thread-${++threads}` } }))
    scriptTurn(peer, (emit, turnId) => {
      emit('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed' } })
    })
    const runner = new CodexRunner({ cwd: '/tmp', prompt: 'hi', connectFn: peer.connectFn, contextReset: recordingDirectory() })
    const events = collect(runner)
    await runner.start()
    expect(runner.info().agentContextReset).toBe(true)
    await runner.clearContext({ agentReason: 'context at 80%' })
    expect(ofType(events, 'conversation_reset')[0]).toMatchObject({ agentReason: 'context at 80%' })
  })
})
