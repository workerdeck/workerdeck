import { vi } from 'vitest'

// vi.waitFor polls every 50 ms by default, which an in-memory runner settles well inside; poll at once instead.
export function eventually<T>(check: () => T | Promise<T>, options: { timeout?: number } = {}): Promise<T> {
  return vi.waitFor(check, { interval: 1, ...options })
}
