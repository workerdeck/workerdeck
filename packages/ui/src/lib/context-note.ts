import type { ProfileEngine } from '@workerdeck/protocol'

export interface ContextNote {
  summary: string
  hint: string
  detail: string[]
  caveat: string
}

const CODEX_CONTEXT_NOTE: ContextNote = {
  summary:
    'Codex budgets 272K input by default and reports 95% of it, so a 1M-class model reads ~258k. That is codex’s price tier, not the model’s ceiling — and it is the number auto-compaction fires on, so the meter is honest.',
  hint: 'Raising it is yours to set: model_context_window in ~/.codex/config.toml — and watch for auto-compaction failing afterwards.',
  detail: [
    'To raise it, set model_context_window in ~/.codex/config.toml, up to 872000 (reported as 828400). Codex clamps to its own max_context_window, itself below OpenAI’s stated 922,000 max input.',
    'Above 272K input, a request bills at 2x input / 1.5x output for the whole request. WorkerDeck never writes this setting — it is a cost decision on your account.',
  ],
  caveat:
    'Raise it and watch for auto-compaction failing: openai/codex #16068 reports it stops firing after the first overflow. Unverified here on 0.149.0.',
}

export function contextNote(engine: ProfileEngine | undefined): ContextNote | undefined {
  return (engine ?? 'claude') === 'codex' ? CODEX_CONTEXT_NOTE : undefined
}
