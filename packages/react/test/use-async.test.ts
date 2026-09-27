import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAsync, type UseAsyncOptions } from '../src/lib/async-guards.ts'
import { renderHook } from './hook-runner.ts'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mount(props: { key: string; options?: UseAsyncOptions }, load: (key: string) => Promise<string>) {
  return renderHook(() => useAsync(() => load(props.key), [props.key], props.options))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useAsync', () => {
  it('loads, then reports the value', async () => {
    const pending = deferred<string>()
    const hook = mount({ key: 'a' }, () => pending.promise)
    expect(hook.current.loading).toBe(true)
    pending.resolve('A')
    await pending.promise
    await Promise.resolve()
    expect(hook.current).toMatchObject({ data: 'A', loading: false, error: undefined })
  })

  it('reports a failure and keeps the last value', async () => {
    let fail = false
    const hook = mount({ key: 'a' }, async () => {
      if (fail) {
        throw new Error('nope')
      }
      return 'A'
    })
    await vi.waitFor(() => expect(hook.current.data).toBe('A'))
    fail = true
    await hook.current.reload()
    expect(hook.current.data).toBe('A')
    expect((hook.current.error as Error).message).toBe('nope')
  })

  it('drops an answer that a newer key superseded', async () => {
    const answers: Record<string, Deferred<string>> = { a: deferred(), b: deferred() }
    const props = { key: 'a' }
    const hook = mount(props, (key) => answers[key]!.promise)
    props.key = 'b'
    hook.rerender()
    answers.b!.resolve('B')
    await answers.b!.promise
    answers.a!.resolve('A')
    await answers.a!.promise
    await Promise.resolve()
    expect(hook.current.data).toBe('B')
  })

  it('does nothing while disabled', () => {
    const load = vi.fn(async () => 'A')
    const hook = mount({ key: 'a', options: { enabled: false } }, load)
    expect(load).not.toHaveBeenCalled()
    expect(hook.current.loading).toBe(false)
  })

  it('polls until unmounted', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => 'A')
    const hook = mount({ key: 'a', options: { pollMs: 1000 } }, load)
    expect(load).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(3)
    hook.unmount()
    await vi.advanceTimersByTimeAsync(2000)
    expect(load).toHaveBeenCalledTimes(3)
  })
})
