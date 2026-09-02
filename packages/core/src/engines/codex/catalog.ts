import type { ModelCatalog } from '../adapter.ts'

// The binary's embedded model table is the truth about reasoning efforts, not the SDK's stale `ModelReasoningEffort` union.
export const CODEX_CATALOG: ModelCatalog = {
  provenance:
    'embedded model presets of @openai/codex@0.151.0 (darwin-arm64 binary), ' + 're-extracted 2026-09-02 and unchanged since 0.149.0',
  models: [
    {
      value: 'gpt-5.6-sol',
      resolvedModel: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      description: 'Latest frontier agentic coding model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-terra',
      resolvedModel: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      description: 'Balanced agentic coding model for everyday work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    },
    {
      value: 'gpt-5.6-luna',
      resolvedModel: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      description: 'Fast and affordable agentic coding model.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      value: 'gpt-5.5',
      resolvedModel: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Frontier model for complex coding, research, and real-world work.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.4',
      resolvedModel: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.4-mini',
      resolvedModel: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      description: 'Small, fast, and cost-efficient model for simpler coding tasks.',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      value: 'gpt-5.2',
      resolvedModel: 'gpt-5.2',
      displayName: 'GPT-5.2',
      description: 'Optimized for professional work and long-running agents.',
      primary: true,
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
}
