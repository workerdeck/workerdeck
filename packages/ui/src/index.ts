// Primitives
export { Button, buttonVariants, type ButtonProps } from './components/ui/Button.tsx'
export { Badge, badgeVariants, type BadgeProps } from './components/ui/Badge.tsx'
export { Card, CardContent, CardHeader, CardTitle } from './components/ui/Card.tsx'
export { Input } from './components/ui/Input.tsx'
export { Textarea } from './components/ui/Textarea.tsx'
export { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from './components/ui/Select.tsx'
export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/ui/AlertDialog.tsx'
export { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './components/ui/Menu.tsx'
export { Dialog, DialogBody, DialogClose, DialogContent, DialogHeader, DialogRow, DialogTrigger } from './components/ui/Dialog.tsx'
export { Tip, TooltipContent, TooltipProvider } from './components/ui/Tooltip.tsx'
export { Toaster, toast } from './components/ui/Sonner.tsx'
export { CopyButton, type CopyButtonProps } from './components/ui/CopyButton.tsx'
export { Spinner } from './components/ui/Spinner.tsx'
export { CodeBlock, type CodeBlockProps } from './components/ui/CodeBlock.tsx'
export { Splitter, type SplitterProps } from './components/ui/Splitter.tsx'
export { Empty, EmptyKey } from './components/ui/Empty.tsx'
export { ProgressRing, type ProgressRingProps } from './components/ui/ProgressRing.tsx'
// Prompt input (vendored just-marketing/prompt-area, themed to these tokens)
export {
  PromptArea,
  usePromptAreaState,
  commandTrigger,
  mentionTrigger,
  hashtagTrigger,
  segmentsToPlainText,
  plainTextToSegments,
  isSegmentsEmpty,
  getChipsByTrigger,
  type PromptAreaHandle,
  type PromptAreaProps,
  type Segment,
  type ChipSegment,
  type TextSegment,
  type TriggerConfig,
  type TriggerSuggestion,
} from './components/prompt-area/index.ts'

// Agent-control components
export {
  SessionPanel,
  type SessionControls,
  type SessionPanelProps,
  type SessionSurfacePanel,
  type SessionVitals,
  type TerminalMetrics,
} from './components/agent/SessionPanel.tsx'
// The workspace layout and its Monaco editor stay unreachable from this entry, at
// `@workerdeck/ui/workspace` — see `src/workspace.ts`.
export { Transcript, type TranscriptProps } from './components/agent/Transcript.tsx'
// The terminal theme. `SessionPanel`/`Transcript` reach it through `variant:
// 'terminal'`; these exports are for a host composing the surface by hand.
export { TerminalSurface, type TerminalSurfaceProps } from './components/terminal/surface.tsx'
export { TerminalTranscript, TerminalItemView, type TerminalTranscriptProps } from './components/terminal/TerminalTranscript.tsx'
export { TerminalStatusLine, type TerminalStatusLineProps } from './components/terminal/StatusLine.tsx'
export { TerminalPermissionPrompt, type TerminalPermissionPromptProps } from './components/terminal/PermissionPrompt.tsx'
export { TerminalQuestionPrompt, type TerminalQuestionPromptProps } from './components/terminal/QuestionPrompt.tsx'
export { TerminalDiff, previewPatch } from './components/terminal/diff.tsx'
export { TerminalMarkdown, type TerminalMarkdownProps } from './components/terminal/markdown.tsx'
export { Band, Blank, Ink, Row, type RowProps, type Tone } from './components/terminal/row.tsx'
export { CopyAction, WithActions, useAffordances, type TerminalAffordances } from './components/terminal/affordances.tsx'
export { Conversation, ConversationContent, ConversationScrollButton, type ConversationProps } from './components/agent/Conversation.tsx'
export { Message, MessageContent, type MessageProps } from './components/agent/Message.tsx'
export {
  TranscriptDensityProvider,
  TranscriptVariantProvider,
  useTranscriptDensity,
  useTranscriptVariant,
  type TranscriptDensity,
  type TranscriptFont,
  type TranscriptVariant,
} from './components/agent/transcript-variant.tsx'
export { Response, type ResponseProps } from './components/agent/Response.tsx'
export { Reasoning, type ReasoningProps } from './components/agent/Reasoning.tsx'
export { Loader } from './components/agent/Loader.tsx'
export { ToolCallCard, type ToolCallCardProps, type ToolCallItem } from './components/agent/ToolCallCard.tsx'
export { FileCard, type FileCardProps, type FileDeliveredItem } from './components/agent/FileCard.tsx'
export { PermissionPrompt, type PermissionPromptProps } from './components/agent/PermissionPrompt.tsx'
export {
  QuestionPrompt,
  QUESTION_BEHAVIORS,
  parseUserQuestions,
  type QuestionPromptProps,
  type QuestionBehaviorMeta,
} from './components/agent/QuestionPrompt.tsx'
export { Composer, skillPrompt, type ComposerFileMatch, type ComposerHandle, type ComposerProps } from './components/agent/Composer.tsx'
export { ModelSelect, type ModelSelectProps } from './components/agent/ModelSelect.tsx'
export {
  PERMISSION_MODES,
  PermissionModeSelect,
  permissionModeChoices,
  permissionModeMeta,
  type PermissionModeChoice,
  type PermissionModeMeta,
  type PermissionModeSelectProps,
} from './components/agent/PermissionModeSelect.tsx'
export { StatusBar, type StatusBarProps } from './components/agent/StatusBar.tsx'
export { ContextDialog, type ContextDialogProps } from './components/agent/ContextDialog.tsx'
export { UsageDialog, type UsageDialogProps } from './components/agent/UsageDialog.tsx'
export { UsageMeters, useMinuteClock } from './components/agent/UsageMeters.tsx'
export { SessionInfoDialog, type SessionInfoDialogProps } from './components/agent/SessionInfoDialog.tsx'
export { McpDialog, type McpDialogProps } from './components/agent/McpDialog.tsx'
export { SkillsDialog, type SkillsDialogProps } from './components/agent/SkillsDialog.tsx'
export { HostFilesDialog, type HostFilesDialogProps } from './components/agent/HostFilesDialog.tsx'
export { SessionList, SessionListItem, type SessionListItemProps, type SessionListProps } from './components/agent/SessionList.tsx'
export { SessionBrowser, rowShapeClass, type SessionBrowserProps } from './components/agent/SessionBrowser.tsx'
// The session card itself — one component, every client; `SessionBrowser` is the
// dashboard's list *around* it.
export { SessionItem, type SessionItemProps } from './components/agent/SessionItem.tsx'
export { SessionStatusIcon } from './components/agent/SessionStatusIcon.tsx'
export { EngineIcon, engineMark, vendorMarkClass, vendorTextClass } from './components/agent/EngineIcon.tsx'
export { type Step, StepRow, StepToggle, runningSteps, sessionSteps } from './components/agent/SessionSteps.tsx'
// The sub-agent takeover's one line, for hosts drawing their own panel chrome.
export { SubagentStrip } from './components/agent/SubagentStrip.tsx'
export { ProjectIcon } from './components/agent/ProjectIcon.tsx'
export { SessionEmptyState, type SessionEmptyStateProps } from './components/agent/SessionEmptyState.tsx'
export { PromptTokenText } from './components/agent/PromptTokenText.tsx'
export { STATUS_META } from './components/agent/status.ts'
export { ContextRing } from './components/agent/ContextRing.tsx'

// Utilities
export { cn } from './lib/utils.ts'
export { copyText } from './lib/clipboard.ts'
export { isMutatingTool, toolIcon } from './lib/tool-icon.ts'
export {
  formatAgoPrecise,
  formatBytes,
  formatCost,
  formatCountdown,
  formatDuration,
  formatRateLimitWindow,
  formatRateLimitWindowLong,
  formatRelativeTime,
  formatTokens,
  friendlyModel,
  rateLimitWindowSeconds,
  toolInputPreview,
} from './lib/format.ts'
