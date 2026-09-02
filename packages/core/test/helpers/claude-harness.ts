// Controllable stand-in for the Claude Agent SDK, shared by every suite that drives
// SessionRunner: emit SDKMessages, capture the options the runner passed and the input it
// streamed back. Two suites used to keep their own copy of this.
import { vi } from 'vitest'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export type HarnessCapabilities = {
  models?: Array<{ value: string; displayName: string; description: string }>
  commands?: Array<{ name: string; description: string; argumentHint: string }>
  contextUsage?: Record<string, unknown>
  usage?: Record<string, unknown>
}

// Pass `capabilities` to also implement supportedModels/supportedCommands/usage.
export function fakeHarness(capabilities?: HarnessCapabilities) {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }
  const interrupt = vi.fn(async () => {})
  const setPermissionMode = vi.fn(async () => {})
  const setModel = vi.fn(async () => {})

  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      messages.push(msg)
    }
  }
  const end = () => {
    done = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: undefined, done: true })
    }
  }

  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const buffered = messages.shift()
      if (buffered !== undefined) {
        return Promise.resolve({ value: buffered, done: false })
      }
      if (done) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt,
    setPermissionMode,
    setModel,
    close: end,
    ...(capabilities
      ? {
          supportedModels: vi.fn(async () => capabilities.models ?? []),
          supportedCommands: vi.fn(async () => capabilities.commands ?? []),
        }
      : {}),
    ...(capabilities?.contextUsage ? { getContextUsage: vi.fn(async () => capabilities.contextUsage) } : {}),
    ...(capabilities?.usage
      ? {
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(async () => capabilities.usage),
        }
      : {}),
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    void (async () => {
      for await (const input of params.prompt as AsyncIterable<SDKUserMessage>) {
        captured.inputs.push(input)
      }
    })()
    return query
  }

  return { emit, end, captured, interrupt, setPermissionMode, setModel, queryFn }
}

// Let the runner's queued microtasks and its message pump drain.
export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}
