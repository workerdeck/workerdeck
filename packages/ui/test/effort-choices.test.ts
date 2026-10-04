import { describe, expect, it } from 'vitest'
import { ENGINE_CAPABILITIES, type ModelOption } from '@workerdeck/protocol'
import { effortChoices } from '../src/components/agent/EffortSelect.tsx'

const models: ModelOption[] = [
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', reasoningEfforts: ['low', 'high', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5', displayName: 'Haiku', reasoningEfforts: [] },
  { value: 'sonnet', displayName: 'Sonnet' },
]

describe('effortChoices', () => {
  it("reads the current model's row, by alias or resolved id", () => {
    expect(effortChoices(models, 'opus', ENGINE_CAPABILITIES.claude)).toEqual(['low', 'high', 'max'])
    expect(effortChoices(models, 'claude-opus-5-5', ENGINE_CAPABILITIES.claude)).toEqual(['low', 'high', 'max'])
    expect(effortChoices(models, 'haiku', ENGINE_CAPABILITIES.claude)).toEqual([])
  })

  it("falls back to the engine's levels for a row without a list or an unknown model", () => {
    expect(effortChoices(models, 'sonnet', ENGINE_CAPABILITIES.claude)).toEqual(ENGINE_CAPABILITIES.claude.reasoningEfforts)
    expect(effortChoices([], undefined, ENGINE_CAPABILITIES.claude)).toEqual(ENGINE_CAPABILITIES.claude.reasoningEfforts)
    expect(effortChoices([], 'kimi', ENGINE_CAPABILITIES.provider)).toEqual([])
  })
})
