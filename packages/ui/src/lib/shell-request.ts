// The agent's shell write tools on a permission card. Allow-lists key on the tool name, and the danger is in the
// payload, so the card shows the command, the typed text and the keys verbatim rather than a JSON summary.
export type ShellRequestPayload =
  | { kind: 'run'; command: string }
  | { kind: 'write'; shellId: string; data?: string; keys?: string[] }
  | { kind: 'kill'; shellId: string }
  | { kind: 'grant'; shellId: string; reason: string }

type RequestLike = { toolName?: unknown; input?: unknown }

const CONTROL_NAMES: Record<string, string> = {
  '\r': 'enter',
  '\n': 'newline',
  '\t': 'tab',
  '\x1b': 'escape',
  '\x7f': 'backspace',
}

type ShellWriteTool = 'shell_run' | 'shell_write' | 'shell_kill' | 'shell_request_write'

const SHELL_WRITE_TOOLS: readonly string[] = ['shell_run', 'shell_write', 'shell_kill', 'shell_request_write']

export function shellToolOf(toolName: unknown): ShellWriteTool | undefined {
  if (typeof toolName !== 'string') {
    return undefined
  }
  const bare = toolName.startsWith('mcp__') ? toolName.slice(toolName.indexOf('__', 5) + 2) : toolName
  return SHELL_WRITE_TOOLS.includes(bare) ? (bare as ShellWriteTool) : undefined
}

export function shellRequestPayload(request: RequestLike | null | undefined): ShellRequestPayload | undefined {
  const tool = shellToolOf(request?.toolName)
  if (!tool) {
    return undefined
  }
  const input = request?.input !== null && typeof request?.input === 'object' ? (request.input as Record<string, unknown>) : {}
  const shellId = typeof input.shellId === 'string' ? input.shellId : ''
  switch (tool) {
    case 'shell_run': {
      return { kind: 'run', command: typeof input.command === 'string' ? input.command : '' }
    }
    case 'shell_write': {
      const keys = Array.isArray(input.keys) ? input.keys.filter((key): key is string => typeof key === 'string') : undefined
      return {
        kind: 'write',
        shellId,
        ...(typeof input.data === 'string' ? { data: input.data } : {}),
        ...(keys && keys.length > 0 ? { keys } : {}),
      }
    }
    case 'shell_kill': {
      return { kind: 'kill', shellId }
    }
    case 'shell_request_write': {
      return { kind: 'grant', shellId, reason: typeof input.reason === 'string' ? input.reason : '' }
    }
  }
}

export function shellRequestTitle(payload: ShellRequestPayload): string {
  switch (payload.kind) {
    case 'run': {
      return 'Agent wants to start a shell'
    }
    case 'write': {
      return `Agent wants to type into shell ${payload.shellId}`
    }
    case 'kill': {
      return `Agent wants to kill shell ${payload.shellId}`
    }
    case 'grant': {
      return `Agent asks to type into your shell ${payload.shellId}`
    }
  }
}

// The lines drawn verbatim under the title. Typed text keeps its shape; a control character is named in brackets
// so a hidden Enter or Escape is visible on the card.
export function shellRequestLines(payload: ShellRequestPayload): string[] {
  switch (payload.kind) {
    case 'run': {
      return payload.command.split('\n').map((line, index) => (index === 0 ? `$ ${line}` : `  ${line}`))
    }
    case 'write': {
      const lines: string[] = []
      if (payload.data !== undefined) {
        lines.push(`types: ${visibleControls(payload.data)}`)
      }
      if (payload.keys) {
        lines.push(`presses: ${payload.keys.map((key) => `[${key}]`).join(' ')}`)
      }
      return lines
    }
    case 'kill': {
      return [`kill ${payload.shellId}`]
    }
    case 'grant': {
      return [`why: ${visibleControls(payload.reason)}`, 'until the shell ends or you revoke it']
    }
  }
}

export function visibleControls(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code >= 0x20 && code !== 0x7f) {
      out += char
      continue
    }
    const named = CONTROL_NAMES[char]
    out += named ? `[${named}]` : `[ctrl-${String.fromCharCode(code + 64).toLowerCase()}]`
  }
  return out
}
