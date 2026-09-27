import { describe, expect, it } from 'vitest'
import type { LanguageModel } from 'ai'
import type { SessionEvent } from '@workerdeck/protocol'
import type { SessionRunnerConfig } from '@workerdeck/core'
import { createProviderRunner } from '../src/lib/provider-runner.ts'
import { BridgeHub } from '../src/services/bridge.ts'

function fakeModel(modelId: string): LanguageModel {
  return { modelId } as unknown as LanguageModel
}

function context() {
  return {
    config: { cwd: process.cwd(), model: 'a' } as SessionRunnerConfig,
    profile: { name: 'p', engine: 'provider' as const },
    bridge: new BridgeHub(),
  }
}

describe('createProviderRunner', () => {
  it('switches models through set_model when the host resolves models per id', async () => {
    const asked: (string | undefined)[] = []
    const runner = await createProviderRunner(context(), {
      model: (id) => {
        asked.push(id)
        return fakeModel(id ?? 'default')
      },
      executor: 'browser',
    })
    const events: SessionEvent[] = []
    runner.subscribe((event) => events.push(event))
    await runner.setModel('b')
    expect(asked).toContain('b')
    expect(events.some((event) => event.type === 'model_changed' && event.model === 'b')).toBe(true)
    runner.close()
  })

  it('refuses set_model when the host supplied one fixed model', async () => {
    const runner = await createProviderRunner(context(), { model: fakeModel('fixed'), executor: 'browser' })
    await expect(runner.setModel('b')).rejects.toThrow(/not supported/)
    runner.close()
  })
})
