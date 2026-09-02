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
