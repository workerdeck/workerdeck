// Primitives
export { Button, buttonVariants, type ButtonProps } from './components/ui/Button.tsx'
export { Badge, badgeVariants, type BadgeProps } from './components/ui/Badge.tsx'
export { Card, CardContent, CardHeader, CardTitle } from './components/ui/Card.tsx'
export { Input } from './components/ui/Input.tsx'
export { Textarea } from './components/ui/Textarea.tsx'
export {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from './components/ui/Select.tsx'
export {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from './components/ui/AlertDialog.tsx'
export {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from './components/ui/Menu.tsx'
export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogRow,
  DialogTrigger,
} from './components/ui/Dialog.tsx'
export { Tip, TooltipContent, TooltipProvider } from './components/ui/Tooltip.tsx'
export { Toaster, toast } from './components/ui/Sonner.tsx'
export { CopyButton, type CopyButtonProps } from './components/ui/CopyButton.tsx'
export { Spinner } from './components/ui/Spinner.tsx'
export { CodeBlock, type CodeBlockProps } from './components/ui/CodeBlock.tsx'
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
export { SessionPanel, type SessionPanelProps } from './components/agent/SessionPanel.tsx'
export { Transcript, type TranscriptProps } from './components/agent/Transcript.tsx'
export {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  type ConversationProps,
} from './components/agent/Conversation.tsx'
export { Message, MessageContent, type MessageProps } from './components/agent/Message.tsx'
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
export {
  Composer,
  type ComposerFileMatch,
  type ComposerProps,
} from './components/agent/Composer.tsx'
export { ModelSelect, type ModelSelectProps } from './components/agent/ModelSelect.tsx'
export {
  PERMISSION_MODES,
  PermissionModeSelect,
  permissionModeMeta,
  type PermissionModeMeta,
  type PermissionModeSelectProps,
} from './components/agent/PermissionModeSelect.tsx'
export { StatusBar, type StatusBarProps } from './components/agent/StatusBar.tsx'
export { ContextDialog, type ContextDialogProps } from './components/agent/ContextDialog.tsx'
export { UsageDialog, type UsageDialogProps } from './components/agent/UsageDialog.tsx'
export {
  SessionInfoDialog,
  type SessionInfoDialogProps,
} from './components/agent/SessionInfoDialog.tsx'
export { McpDialog, type McpDialogProps } from './components/agent/McpDialog.tsx'
export { HostFilesDialog, type HostFilesDialogProps } from './components/agent/HostFilesDialog.tsx'
export {
  SessionList,
  SessionListItem,
  type SessionListItemProps,
  type SessionListProps,
} from './components/agent/SessionList.tsx'
export {
  SessionEmptyState,
  type SessionEmptyStateProps,
} from './components/agent/SessionEmptyState.tsx'
export { PromptTokenText } from './components/agent/PromptTokenText.tsx'
export { STATUS_META } from './components/agent/status.ts'

// Utilities
export { cn } from './lib/utils.ts'
export { toolIcon } from './lib/tool-icon.ts'
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
  rateLimitWindowSeconds,
  toolInputPreview,
} from './lib/format.ts'
