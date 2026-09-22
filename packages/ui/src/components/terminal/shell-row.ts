import type { ShellItem } from '@workerdeck/react'

export const SHELL_GLYPH = '$'

export const SHELL_KILL_GLYPH = '✕'

export const SHELL_EXPAND_CHARS = 100_000

export const SHELL_MISSING = 'output expired or not tracked by this gateway'

export function shellLabel(item: ShellItem): string {
  return item.shell.label || item.shell.command.split('\n')[0] || ''
}

export function shellStatusText(item: ShellItem): string {
  const shell = item.shell
  if (shell.status === 'running') {
    return 'running'
  }
  if (typeof shell.exitCode === 'number') {
    return shell.exitCode === 0 ? 'exit 0' : `exit ${shell.exitCode}`
  }
  switch (shell.endReason) {
    case 'killed': {
      return 'killed'
    }
    case 'timeout': {
      return 'timed out'
    }
    case 'server_stopped': {
      return 'killed: the gateway stopped'
    }
    case 'server_restarted': {
      return 'ended: the gateway restarted, the process may still be running'
    }
    case 'spawn_failed': {
      return 'failed to start'
    }
    default: {
      return 'ended'
    }
  }
}

export function shellFailed(item: ShellItem): boolean {
  return item.shell.status === 'exited' && item.shell.exitCode !== 0
}

export function shellHeaderText(item: ShellItem): string {
  const kill = item.shell.status === 'running' ? ` ${SHELL_KILL_GLYPH}` : ''
  return `${shellLabel(item)} · ${shellStatusText(item)}${kill}`
}

export function shellBodyLines(item: ShellItem, open: boolean): string[] {
  const source = open && item.expanded !== undefined ? item.expanded : item.text
  if (source === '') {
    return []
  }
  const lines = source.split('\n')
  if (!open) {
    return lines
  }
  const kept: string[] = []
  let chars = 0
  for (const line of lines) {
    if (kept.length > 0 && chars + line.length > SHELL_EXPAND_CHARS) {
      break
    }
    kept.push(line)
    chars += line.length + 1
  }
  return kept
}

// The footer is the row's one affordance line: what expanding will fetch, what it clipped, or why it cannot.
export function shellFooterText(item: ShellItem, open: boolean, shown: number): string | undefined {
  if (item.missing) {
    return SHELL_MISSING
  }
  if (!open) {
    return item.truncated ? '… more output - expand to fetch it' : undefined
  }
  const total = item.expanded === undefined ? undefined : item.expanded.split('\n').length
  if (total !== undefined && total > shown) {
    return `… +${(total - shown).toLocaleString()} lines not shown`
  }
  if (item.expanded === undefined && item.truncated) {
    return '… fetching the full output'
  }
  return undefined
}
