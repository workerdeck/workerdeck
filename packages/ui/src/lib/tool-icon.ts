import {
  ArrowDownCircle,
  CheckSquare,
  FileDiff,
  FileText,
  FolderSearch,
  Globe,
  Image,
  type LucideIcon,
  MessageCircleQuestion,
  PencilLine,
  Puzzle,
  Search,
  Sparkles,
  SquarePen,
  Terminal,
  UsersRound,
  Wrench,
} from 'lucide-react'

/**
 * An icon per tool, so a transcript can be skimmed by shape rather than read.
 *
 * The same mapping the iOS app makes, in lucide's vocabulary rather than SF
 * Symbols — the two clients should be recognisably showing the same thing. An
 * unknown tool falls back to a wrench, and an MCP tool (`mcp__server__name`) to
 * the puzzle piece the MCP screens use, because "which server is this from" is
 * the useful thing to see at a glance.
 */
export function toolIcon(toolName: string): LucideIcon {
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
      return Terminal
    case 'Read':
      return FileText
    case 'Write':
      return SquarePen
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return PencilLine
    case 'Glob':
      return FolderSearch
    case 'Grep':
      return Search
    case 'WebFetch':
      return ArrowDownCircle
    case 'WebSearch':
      return Globe
    case 'Task':
    case 'Agent':
      return UsersRound
    case 'TodoWrite':
      return CheckSquare
    case 'Skill':
      return Sparkles
    case 'AskUserQuestion':
      return MessageCircleQuestion
    // The codex engine's own tool names (see its runner's item mapping).
    case 'CodexCommand':
      return Terminal
    case 'CodexFileChange':
      return FileDiff
    case 'CodexWebSearch':
      return Globe
    case 'CodexImageGeneration':
    case 'CodexImageView':
      return Image
    default:
      return toolName.startsWith('mcp__') ? Puzzle : Wrench
  }
}

/**
 * Is this tool a shell command?
 *
 * Its own question because a run of them is *one* thing the reader skims past:
 * the terminal theme collapses consecutive shell calls into a single "Ran N
 * shell commands" line, the way the CLI does. Names from both first-party
 * engines. `BashOutput`/`KillShell` are excluded on purpose — they manage a
 * background shell rather than run something, and folding them into the count
 * would inflate it.
 */
export function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'CodexCommand'
}

/**
 * Does this tool *change* the workspace?
 *
 * Worth its own colour in a transcript: skimming a run, "what did it edit" is a
 * different question from "what did it look at", and a write is the one you
 * might need to undo. Names from both first-party engines; an MCP tool is
 * unknowable from its name, so it reads as neutral rather than guessed.
 */
export function isMutatingTool(toolName: string): boolean {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Update':
    case 'CodexFileChange':
      return true
    default:
      return false
  }
}
