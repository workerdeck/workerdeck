/**
 * Vendored from just-marketing/prompt-area (MIT) via its shadcn registry, so the
 * popover/chips can be themed with this package's tokens. Upstream:
 * https://github.com/just-marketing/prompt-area
 */
export { PromptArea } from './prompt-area.tsx'
export { usePromptAreaState } from './use-prompt-area-state.ts'
export { commandTrigger, mentionTrigger, hashtagTrigger } from './trigger-presets.ts'
export { segmentsToPlainText, plainTextToSegments, isSegmentsEmpty, getChipsByTrigger } from './segment-helpers.ts'
export type { PromptAreaHandle, PromptAreaProps, Segment, ChipSegment, TextSegment, TriggerConfig, TriggerSuggestion } from './types.ts'
