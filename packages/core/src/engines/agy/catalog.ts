import type { ModelCatalog } from '../adapter.ts'

// Each model's thinking levels are the `thought_level` config option agy reports once that model is selected.
export const AGY_CATALOG: ModelCatalog = {
  provenance: 'session/new configOptions of agy 1.5.16 (Gemini API key), extracted 2026-11-24',
  defaultModel: 'gemini-4-neon',
  models: [
    { value: 'gemini-4-neon', displayName: 'Gemini 4 Neon', primary: true, reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon', primary: true, reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-4-hydrogen', displayName: 'Gemini 4 Hydrogen', primary: true, reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-4-argon', displayName: 'Gemini 4 Argon', reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-3.6-flash', displayName: 'Gemini 3.6 Flash', reasoningEfforts: ['low', 'high'] },
    { value: 'gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', reasoningEfforts: ['low', 'high'] },
  ],
}
