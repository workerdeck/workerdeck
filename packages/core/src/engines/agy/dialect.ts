import type { AcpDialect } from '../acp/runner.ts'
import { AGY_CATALOG } from './catalog.ts'

const MODE_IDS: Record<string, string> = {
  default: 'default',
  acceptEdits: 'accept-edits',
  plan: 'plan',
  bypassPermissions: 'accept-edits',
}

// agy reads appended instructions only from its own `_meta` block; the standard ACP `systemPrompt` field is ignored.
export const AGY_DIALECT: AcpDialect = {
  engine: 'agy',
  label: 'agy',
  vendor: 'google',
  catalog: AGY_CATALOG,
  sessionMeta: (instructions) => (instructions ? { antigravity: { systemPrompt: { append: instructions } } } : undefined),
  modeId: (mode) => MODE_IDS[mode],
  modelOption: 'model',
  effortOption: 'thought_level',
  modeOption: 'mode',
}
