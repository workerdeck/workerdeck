import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Push-based single-consumer AsyncIterable bridging imperative sendMessage() calls
 * into the streaming `prompt` the Agent SDK consumes.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  #buffer: SDKUserMessage[] = []
  #waiter: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  #done = false

  push(message: SDKUserMessage): void {
    if (this.#done) return
    if (this.#waiter) {
      const resolve = this.#waiter
      this.#waiter = null
      resolve({ value: message, done: false })
    } else {
      this.#buffer.push(message)
    }
  }

  end(): void {
    if (this.#done) return
    this.#done = true
    if (this.#waiter) {
      const resolve = this.#waiter
      this.#waiter = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const buffered = this.#buffer.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.#done) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => {
          this.#waiter = resolve
        })
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
