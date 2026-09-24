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

export function toolIcon(toolName: string): LucideIcon {
  switch (toolName) {
    case 'Bash':
    case 'BashOutput':
    case 'KillShell':
    case 'shell_list':
    case 'shell_read':
    case 'shell_run':
    case 'shell_write':
    case 'shell_kill':
    case 'mcp__workerdeck__shell_list':
    case 'mcp__workerdeck__shell_read':
    case 'mcp__workerdeck__shell_run':
    case 'mcp__workerdeck__shell_write':
    case 'mcp__workerdeck__shell_kill': {
      return Terminal
    }
    case 'Read': {
      return FileText
    }
    case 'Write': {
      return SquarePen
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      return PencilLine
    }
    case 'Glob': {
      return FolderSearch
    }
    case 'Grep': {
      return Search
    }
    case 'WebFetch': {
      return ArrowDownCircle
    }
    case 'WebSearch': {
      return Globe
    }
    case 'Task':
    case 'Agent': {
      return UsersRound
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskGet':
    case 'TaskList': {
      return CheckSquare
    }
    case 'Skill': {
      return Sparkles
    }
    case 'AskUserQuestion': {
      return MessageCircleQuestion
    }
    case 'CodexCommand': {
      return Terminal
    }
    case 'CodexFileChange': {
      return FileDiff
    }
    case 'CodexWebSearch': {
      return Globe
    }
    case 'CodexImageGeneration':
    case 'CodexImageView': {
      return Image
    }
    default: {
      return toolName.startsWith('mcp__') ? Puzzle : Wrench
    }
  }
}

// `BashOutput`/`KillShell` are excluded on purpose: they manage a background shell rather than run one.
export function isShellTool(toolName: string): boolean {
  return toolName === 'Bash' || toolName === 'CodexCommand'
}

export function isMutatingTool(toolName: string): boolean {
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Update':
    case 'CodexFileChange': {
      return true
    }
    default: {
      return false
    }
  }
}
