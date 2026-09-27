import * as React from 'react'

// No DOM renderer ships in this package's devDeps, so hooks run against a minimal dispatcher that
// implements the handful of built-ins the hooks under test call.
type Internals = { H: unknown }
const INTERNALS_KEY = '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE'
const internals = (React as unknown as Record<string, Internals>)[INTERNALS_KEY]!

type Effect = { deps: readonly unknown[] | undefined; cleanup?: (() => void) | void }

export type HookHandle<R> = {
  readonly current: R
  readonly renders: number
  rerender: () => void
  unmount: () => void
}

function depsChanged(prev: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (prev === undefined || next === undefined || prev.length !== next.length) {
    return true
  }
  return next.some((value, index) => !Object.is(value, prev[index]))
}

export function renderHook<R>(hook: () => R): HookHandle<R> {
  const slots: unknown[] = []
  const pendingEffects: Array<() => void> = []
  let cursor = 0
  let result!: R
  let renders = 0
  let dirty = false
  let flushing = false
  let unmounted = false

  function next<T>(init: () => T): { slot: T; index: number } {
    const index = cursor++
    if (!(index in slots)) {
      slots[index] = init()
    }
    return { slot: slots[index] as T, index }
  }

  function schedule(): void {
    if (unmounted) {
      return
    }
    dirty = true
    if (!flushing) {
      flush()
    }
  }

  function useReducer<S, A>(reducer: (state: S, action: A) => S, arg: unknown, init?: (arg: unknown) => S): [S, (action: A) => void] {
    const { slot } = next(() => {
      const cell = { state: (init ? init(arg) : arg) as S, dispatch: (_action: A) => {} }
      cell.dispatch = (action: A) => {
        const nextState = reducer(cell.state, action)
        if (!Object.is(nextState, cell.state)) {
          cell.state = nextState
          schedule()
        }
      }
      return cell
    })
    return [slot.state, slot.dispatch]
  }

  function useState<S>(initial: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void] {
    return useReducer<S, S | ((prev: S) => S)>(
      (state, action) => (typeof action === 'function' ? (action as (prev: S) => S)(state) : action),
      undefined,
      () => (typeof initial === 'function' ? (initial as () => S)() : initial),
    )
  }

  function useMemo<T>(factory: () => T, deps: readonly unknown[] | undefined): T {
    const index = cursor++
    const held = slots[index] as { value: T; deps: readonly unknown[] | undefined } | undefined
    if (held && !depsChanged(held.deps, deps)) {
      return held.value
    }
    const value = factory()
    slots[index] = { value, deps }
    return value
  }

  function useEffect(effect: () => (() => void) | void, deps?: readonly unknown[]): void {
    const index = cursor++
    const held = slots[index] as Effect | undefined
    if (held && !depsChanged(held.deps, deps)) {
      return
    }
    pendingEffects.push(() => {
      held?.cleanup?.()
      slots[index] = { deps, cleanup: effect() }
    })
  }

  function useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T): T {
    const { slot } = next(() => ({ unsubscribe: subscribe(() => schedule()), subscribe }))
    if (slot.subscribe !== subscribe) {
      slot.unsubscribe()
      slot.unsubscribe = subscribe(() => schedule())
      slot.subscribe = subscribe
    }
    return getSnapshot()
  }

  const dispatcher = {
    useState,
    useReducer,
    useMemo,
    useCallback: <T>(callback: T, deps: readonly unknown[]) => useMemo(() => callback, deps),
    useRef: <T>(initial: T) => next(() => ({ current: initial })).slot,
    useEffect,
    useLayoutEffect: useEffect,
    useSyncExternalStore,
  }

  function flush(): void {
    let guard = 0
    flushing = true
    do {
      dirty = false
      if (++guard > 100) {
        throw new Error('render loop')
      }
      const previous = internals.H
      internals.H = dispatcher
      cursor = 0
      try {
        result = hook()
        renders++
      } finally {
        internals.H = previous
      }
      for (const run of pendingEffects.splice(0)) {
        run()
      }
    } while (dirty)
    flushing = false
  }

  flush()

  return {
    get current() {
      return result
    },
    get renders() {
      return renders
    },
    rerender: () => schedule(),
    unmount: () => {
      unmounted = true
      for (const slot of slots) {
        const effect = slot as Partial<Effect> & { unsubscribe?: () => void }
        if (effect && typeof effect === 'object' && 'cleanup' in effect) {
          effect.cleanup?.()
        }
        effect?.unsubscribe?.()
      }
    },
  }
}
