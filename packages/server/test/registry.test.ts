import type { Runner, SessionRunnerConfig } from '@workerdeck/core'
import { describe, expect, it } from 'vitest'
import { SessionRegistry } from '../src/services/registry.ts'
import { ParkableRunner } from './parkable-runner.ts'

function runner(id: string): Runner {
  return new ParkableRunner(id, { cwd: '/tmp' } as SessionRunnerConfig)
}

describe('SessionRegistry.observe', () => {
  it('replays what is already registered, so a late observer misses nothing', () => {
    const registry = new SessionRegistry()
    registry.register(runner('a'))
    registry.register(runner('b'))

    const seen: string[] = []
    registry.observe((r) => seen.push(r.id))
    expect(seen).toEqual(['a', 'b'])

    registry.register(runner('c'))
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  it('does not announce a re-register of the same runner, matching onRegister', () => {
    const registry = new SessionRegistry()
    const seen: string[] = []
    const only = runner('a')
    registry.observe((r) => seen.push(r.id))
    registry.register(only)
    registry.register(only)
    expect(seen).toEqual(['a'])
  })

  it('stops on unsubscribe, and runs beside the constructor hook rather than replacing it', () => {
    const constructed: string[] = []
    const registry = new SessionRegistry({ onRegister: (r) => constructed.push(r.id) })
    const seen: string[] = []
    const stop = registry.observe((r) => seen.push(r.id))

    registry.register(runner('a'))
    stop()
    registry.register(runner('b'))

    expect(seen).toEqual(['a'])
    expect(constructed).toEqual(['a', 'b'])
  })
})

describe('SessionRegistry detachers', () => {
  it('runs what a registration returned when the runner leaves, once, whichever way it leaves', () => {
    const detached: string[] = []
    const registry = new SessionRegistry({ onRegister: (r) => () => detached.push(`hook:${r.id}`) })
    registry.observe((r) => () => detached.push(`observer:${r.id}`))

    registry.register(runner('a'))
    registry.register(runner('b'))
    expect(detached).toEqual([])

    registry.evict('a')
    expect(detached).toEqual(['hook:a', 'observer:a'])

    registry.evict('a')
    expect(detached).toEqual(['hook:a', 'observer:a'])

    registry.remove('b')
    expect(detached).toEqual(['hook:a', 'observer:a', 'hook:b', 'observer:b'])
  })

  it('does not detach on a re-register of the same runner, because nothing re-attached', () => {
    const detached: string[] = []
    const registry = new SessionRegistry({ onRegister: (r) => () => detached.push(r.id) })
    const only = runner('a')
    registry.register(only)
    registry.register(only)
    expect(detached).toEqual([])
    registry.evict('a')
    expect(detached).toEqual(['a'])
  })

  it('leaves a hook that returns nothing exactly as it was', () => {
    const seen: string[] = []
    const registry = new SessionRegistry({ onRegister: (r) => seen.push(r.id) })
    registry.register(runner('a'))
    expect(() => registry.evict('a')).not.toThrow()
    expect(seen).toEqual(['a'])
  })
})
