import type { ModelCatalog } from '../adapter.ts'

// The binary's embedded model table is the truth about reasoning efforts, not the SDK's stale `ModelReasoningEffort` union.
export const CODEX_CATALOG: ModelCatalog = {
  provenance: 'embedded model presets of @openai/codex@0.158.0 (darwin-arm64 binary), re-extracted 2026-09-29',
  models: [
    {
      value: 'gpt-6-astra',
      resolvedModel: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      description: 'Frontier intelligence for the most demanding work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-6-sol',
      resolvedModel: 'gpt-6-sol',
      displayName: 'GPT-6 Sol',
      description: 'Workhorse model for coding and everyday work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-6-luna',
      resolvedModel: 'gpt-6-luna',
      displayName: 'GPT-6 Luna',
      description: 'Fast and affordable model for easier tasks.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'gpt-5.6-sol',
      resolvedModel: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      description: 'Older coding model for complex work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      description: 'Older balanced model for straightforward work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      description: 'Older fast and efficient model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'gpt-5.5',
      resolvedModel: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Legacy coding model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
}
