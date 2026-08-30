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
 * An icon per tool. The same mapping the iOS app makes in SF Symbols — keep
 * the two clients recognisably in step. Unknown tools fall back to a wrench,
 * MCP tools (`mcp__server__name`) to the puzzle piece the MCP screens use.
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
 * Is this tool a shell command? Drives the terminal theme's "Ran N shell
 * commands" fold. `BashOutput`/`KillShell` are excluded on purpose — they
 * manage a background shell rather than run something.
 */
export function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'CodexCommand'
}

/**
 * Does this tool *change* the workspace? Names from both first-party engines;
 * an MCP tool is unknowable from its name, so it reads as neutral rather than
 * guessed.
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
