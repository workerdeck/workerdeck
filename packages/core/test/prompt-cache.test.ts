import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import type { SessionEvent } from '@workerdeck/protocol'
import { AiSdkRunner } from '../src/index.ts'
import { markPrompt } from '../src/engines/provider/prompt-cache.ts'
import { streamText } from './helpers/ai-sdk-mocks.ts'
import { waitFor } from './helpers/wait.ts'

type Params = Parameters<typeof markPrompt>[0]
const EPHEMERAL = { type: 'ephemeral' as const }

function params(prompt: unknown[], extra: Record<string, unknown> = {}): Params {
  return { prompt, ...extra } as unknown as Params
}

function cacheOf(message: unknown): unknown {
  return (message as { providerOptions?: { anthropic?: { cacheControl?: unknown } } }).providerOptions?.anthropic?.cacheControl
}

const system = { role: 'system', content: 'You are terse.' }
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })

describe('markPrompt', () => {
  it('marks the last system message and the last message, leaving the caller prompt alone', () => {
    const prompt = [system, user('one'), { role: 'assistant', content: [{ type: 'text', text: 'two' }] }, user('three')]
    const marked = markPrompt(params(prompt), EPHEMERAL).prompt
    expect(marked.map(cacheOf)).toEqual([EPHEMERAL, undefined, undefined, EPHEMERAL])
    expect(prompt.map(cacheOf)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('merges into options a message already carries', () => {
    const tagged = { ...user('hi'), providerOptions: { anthropic: { other: 1 }, openai: { x: 2 } } }
    const [marked] = markPrompt(params([tagged]), { type: 'ephemeral', ttl: '1h' }).prompt
    expect(marked?.providerOptions).toEqual({ anthropic: { other: 1, cacheControl: { type: 'ephemeral', ttl: '1h' } }, openai: { x: 2 } })
  })

  it('never passes four breakpoints, counting the caller marks on tools, parts and messages', () => {
    const mark = { anthropic: { cacheControl: EPHEMERAL } }
    const prompt = [
      system,
      { role: 'user', content: [{ type: 'text', text: 'a', providerOptions: mark }] },
      { ...user('b'), providerOptions: mark },
      user('c'),
    ]
    const marked = markPrompt(params(prompt, { tools: [{ type: 'function', name: 't', providerOptions: mark }] }), EPHEMERAL).prompt
    expect(cacheOf(marked[3])).toEqual(EPHEMERAL)
    expect(cacheOf(marked[0])).toBeUndefined()
  })

  it('leaves the rolling mark to a request-level cacheControl', () => {
    const marked = markPrompt(params([system, user('hi')], { providerOptions: { anthropic: { cacheControl: EPHEMERAL } } }), EPHEMERAL).prompt
    expect(marked.map(cacheOf)).toEqual([EPHEMERAL, undefined])
  })
})

describe('AiSdkRunner prompt cache', () => {
  async function promptSent(provider: string, promptCache?: false) {
    const model = new MockLanguageModelV3({ provider, modelId: 'claude-haiku-5-5', doStream: streamText('ok') })
    const runner = new AiSdkRunner({ languageModel: model, instructions: 'Be brief.', ...(promptCache === false && { promptCache }) })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    void runner.start()
    runner.sendMessage('hi')
    await waitFor(() => events.some((event) => event.type === 'turn_result'))
    return model.doStreamCalls[0]?.prompt ?? []
  }

  it('marks an Anthropic model call by default', async () => {
    const prompt = await promptSent('anthropic.messages')
    expect(prompt.map(cacheOf)).toEqual([EPHEMERAL, EPHEMERAL])
  })

  it('leaves other providers and an explicit opt-out untouched', async () => {
    expect((await promptSent('openai.responses')).map(cacheOf)).toEqual([undefined, undefined])
    expect((await promptSent('anthropic.messages', false)).map(cacheOf)).toEqual([undefined, undefined])
  })
})
