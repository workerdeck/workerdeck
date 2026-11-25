import type { AcpDialect } from '../acp/runner.ts'
import { GEMINI_CATALOG } from './catalog.ts'

const MODE_IDS: Record<string, string> = {
  default: 'default',
  acceptEdits: 'accept-edits',
  plan: 'plan',
  auto: 'auto',
  bypassPermissions: 'accept-edits',
}

// agy reads appended instructions only from its own `_meta` block; the standard ACP `systemPrompt` field is ignored.
export const GEMINI_DIALECT: AcpDialect = {
  engine: 'gemini',
  label: 'Gemini',
  vendor: 'google',
  catalog: GEMINI_CATALOG,
  sessionMeta: (instructions) => (instructions ? { antigravity: { systemPrompt: { append: instructions } } } : undefined),
  modeId: (mode) => MODE_IDS[mode],
  modelOption: 'model',
  effortOption: 'thought_level',
  modeOption: 'mode',
}
