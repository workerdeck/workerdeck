import { describe, expect, it, vi } from 'vitest'
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { probeClaudeModels } from '../src/engines/claude/supported-models.ts'

function fakeQuery(supportedModels: () => Promise<unknown>) {
  const seen: { options?: Options; inputs: SDKUserMessage[]; promptDone: boolean } = { inputs: [], promptDone: false }
  const close = vi.fn()
  const queryFn = ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    seen.options = params.options
    void (async () => {
      for await (const input of params.prompt) {
        seen.inputs.push(input)
      }
      seen.promptDone = true
    })()
    return { supportedModels, close } as unknown as Query
  }) as never
  return { queryFn, seen, close }
}

describe('probeClaudeModels', () => {
  it('returns the shaped list without sending a prompt, then closes the engine', async () => {
    const { queryFn, seen, close } = fakeQuery(async () => [
      { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)' },
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'max'] },
      { value: 'claude-mythos-5-1', resolvedModel: 'claude-mythos-5-1', displayName: 'Mythos 5.1' },
    ])
    const models = await probeClaudeModels({ CLAUDE_CONFIG_DIR: '/x', WORKERDECK_AUTH_KEY: 'secret' }, { queryFn })
    expect(models?.map((m) => [m.value, m.displayName, m.primary])).toEqual([
      ['opus', 'Opus 5.5', true],
      ['claude-mythos-5-1', 'Mythos 5.1', true],
    ])
    expect(close).toHaveBeenCalledOnce()
    expect(seen.options?.env?.CLAUDE_CONFIG_DIR).toBe('/x')
    expect(seen.options?.env?.WORKERDECK_AUTH_KEY).toBeUndefined()
    expect(seen.options?.strictMcpConfig).toBe(true)
    expect(seen.options?.mcpServers).toEqual({})
    await vi.waitFor(() => expect(seen.promptDone).toBe(true))
    expect(seen.inputs).toEqual([])
  })

  it('reads a failure, an empty list or a timeout as no answer', async () => {
    expect(await probeClaudeModels({}, { queryFn: fakeQuery(async () => Promise.reject(new Error('auth'))).queryFn })).toBeUndefined()
    expect(await probeClaudeModels({}, { queryFn: fakeQuery(async () => []).queryFn })).toBeUndefined()
    const hung = fakeQuery(() => new Promise(() => {}))
    expect(await probeClaudeModels({}, { queryFn: hung.queryFn, timeoutMs: 10 })).toBeUndefined()
    expect(hung.close).toHaveBeenCalledOnce()
  })
})
