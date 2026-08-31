import type { ModelCatalog } from '../adapter.ts'

export const CLAUDE_CATALOG: ModelCatalog = {
  provenance:
    'supportedModels() of @anthropic-ai/claude-agent-sdk 0.3.221 (Claude Code CLI), ' +
    'extracted 2026-08-05; older-model rows hand-maintained',
  models: [
    {
      value: 'claude-fable-5[1m]',
      resolvedModel: 'claude-fable-5',
      displayName: 'Fable 5',
      description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'opus[1m]',
      resolvedModel: 'claude-opus-5[1m]',
      displayName: 'Opus 5',
      description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'claude-opus-4-8',
      resolvedModel: 'claude-opus-4-8',
      displayName: 'Opus 4.8',
      description: 'Opus 4.8 · Previous Opus generation',
    },
    {
      value: 'sonnet',
      resolvedModel: 'claude-sonnet-5',
      displayName: 'Sonnet 5',
      description: 'Sonnet 5 · Efficient for routine tasks',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'claude-sonnet-4-6',
      resolvedModel: 'claude-sonnet-4-6',
      displayName: 'Sonnet 4.6',
      description: 'Sonnet 4.6 · Previous Sonnet generation',
    },
    {
      value: 'haiku',
      resolvedModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      description: 'Haiku 4.5 · Fastest for quick answers',
      primary: true,
      // Explicitly none, not absent: an absent field means "the engine's default set".
      reasoningEfforts: [],
    },
  ],
}
