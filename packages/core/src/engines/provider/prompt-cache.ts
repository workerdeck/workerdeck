import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai'

// `false` turns it off; the TTL defaults to Anthropic's 5 minutes.
export type PromptCacheOption = false | { ttl?: '5m' | '1h' }

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params']
type PromptMessage = CallOptions['prompt'][number]
type ProviderOptions = Record<string, Record<string, unknown> | undefined> | undefined

const MAX_BREAKPOINTS = 4

// Anthropic caches only up to a marked block. Two marks: the last system message (tools render before it, so the tools
// and instructions every step shares) and the last message (a rolling mark each tool-loop step and the next turn read).
// Other providers, and models given as a gateway id string, pass through untouched.
export function withPromptCache(model: LanguageModel, option: PromptCacheOption | undefined): LanguageModel {
  if (option === false || typeof model === 'string' || !isAnthropic(model.provider)) {
    return model
  }
  const cacheControl = { type: 'ephemeral' as const, ...(option?.ttl ? { ttl: option.ttl } : {}) }
  return wrapLanguageModel({
    model,
    middleware: { transformParams: async ({ params }) => markPrompt(params, cacheControl) },
  })
}

function isAnthropic(provider: string): boolean {
  return provider.split('.').includes('anthropic')
}

export function markPrompt(params: CallOptions, cacheControl: { type: 'ephemeral'; ttl?: '5m' | '1h' }): CallOptions {
  const prompt = params.prompt
  const requestLevel = anthropicCache(params.providerOptions as ProviderOptions) !== undefined
  let free = MAX_BREAKPOINTS - countMarks(params) - (requestLevel ? 1 : 0)
  const targets: number[] = []
  const last = prompt.length - 1
  if (last >= 0 && !requestLevel && !isMarked(prompt[last]) && free > 0) {
    targets.push(last)
    free -= 1
  }
  const system = prompt.map((message) => message.role).lastIndexOf('system')
  if (system >= 0 && system !== last && !isMarked(prompt[system]) && free > 0) {
    targets.push(system)
  }
  if (targets.length === 0) {
    return params
  }
  return {
    ...params,
    prompt: prompt.map((message, index) => (targets.includes(index) ? mark(message, cacheControl) : message)),
  }
}

function mark(message: PromptMessage, cacheControl: object): PromptMessage {
  const options = message.providerOptions as ProviderOptions
  return { ...message, providerOptions: { ...options, anthropic: { ...options?.anthropic, cacheControl } } } as PromptMessage
}

function anthropicCache(options: ProviderOptions): unknown {
  return options?.anthropic?.cacheControl ?? options?.anthropic?.cache_control
}

function isMarked(message: PromptMessage): boolean {
  if (anthropicCache(message.providerOptions as ProviderOptions) !== undefined) {
    return true
  }
  return Array.isArray(message.content) && message.content.some((part) => anthropicCache(part.providerOptions as ProviderOptions) !== undefined)
}

function countMarks(params: CallOptions): number {
  let marks = 0
  for (const tool of params.tools ?? []) {
    marks += anthropicCache((tool as { providerOptions?: ProviderOptions }).providerOptions) === undefined ? 0 : 1
  }
  for (const message of params.prompt) {
    marks += anthropicCache(message.providerOptions as ProviderOptions) === undefined ? 0 : 1
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        marks += anthropicCache(part.providerOptions as ProviderOptions) === undefined ? 0 : 1
      }
    }
  }
  return marks
}
