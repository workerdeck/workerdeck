import type { ModelCatalog } from '../adapter.ts'

/**
 * The Claude engine's model catalog — what a create form offers before any
 * session has run.
 *
 * **Refresh procedure** (release checklist): run `supportedModels()` on a
 * throwaway SDK query (no tokens spent) and re-apply the shaping rules of
 * `modelOptionsFromSdk` (`src/normalize.ts`) at authoring time: drop the
 * `default` sentinel row, derive display names from resolved ids where
 * unambiguous, mark the newest of each family `primary`, sort by family rank.
 * A unit test replays the raw extraction through `modelOptionsFromSdk` and
 * asserts these rows match, so the rules cannot drift.
 *
 * Two things the live `capabilities` event can never offer:
 * - rows for **older models** the CLI no longer reports (hand-maintained, the
 *   accepted cost of a static catalog; the CLI silently downgrades an effort a
 *   model doesn't support, so `reasoningEfforts` is omitted on them and the
 *   engine default set applies);
 * - an answer on a **cold server**. The live event still exists and remains
 *   the in-session truth for the model switcher; this catalog is the
 *   create-form truth.
 *
 * `defaultModel` is deliberately NOT here: a claude profile's default is the
 * operator's CLI config, unknowable statically.
 */
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
    // Older, still-servable ids the CLI no longer lists ("more models").
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
      // Explicitly none: the CLI reports no effort support for Haiku 4.5, and
      // an absent field would wrongly imply the engine's default set.
      reasoningEfforts: [],
    },
  ],
}
