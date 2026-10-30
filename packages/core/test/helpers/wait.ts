import { vi } from 'vitest'

// Poll until `predicate` holds. The runner suites are event-driven with no completion
// promise to await, so every one of them needs this; three of them used to define it.
export async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, 5))
  }
}

// vi.waitFor polls every 50 ms by default, which an in-memory runner settles well inside; poll at once instead.
export function eventually<T>(check: () => T | Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  return vi.waitFor(check, { interval: 1, ...options })
}
