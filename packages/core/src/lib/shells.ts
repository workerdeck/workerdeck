import { z } from 'zod'
import {
  SHELL_COMMAND_MAX,
  SHELL_INPUT_MAX,
  SHELL_READ_DEFAULT_LINES,
  SHELL_READ_MAX_LINES,
  SHELL_WAIT_DEFAULT_MS,
  SHELL_WAIT_MAX_MS,
  type ShellEndReason,
  type ShellInfo,
  type ShellOwner,
  type ShellStatus,
  errorMessage,
} from '@workerdeck/protocol'
import {
  defineToolFamily,
  globalSlot,
  invalidArguments,
  lateBoundDirectory,
  type GatewayToolOutput,
  type GatewayToolSpec,
} from './gateway-tools.ts'

export type ShellSummary = {
  id: string
  ordinal: number
  command: string
  label: string
  cwd: string
  owner: ShellOwner
  status: ShellStatus
  startedAt: number
  endedAt?: number
  exitCode?: number
  endReason?: ShellEndReason
  bytes: number
  capped?: boolean
  interactive?: boolean
  agentWrite?: boolean
}

export type ShellView = 'lines' | 'screen'

export type ShellWait = { outcome: 'matched' | 'timeout' | 'exited'; match?: string; ms: number }

export type ShellReadResult = {
  shell: ShellSummary
  view: ShellView
  text: string
  lines: number
  totalLines: number
  truncated: boolean
  wait?: ShellWait
}

export type ShellReadOptions = { tail?: number; view?: ShellView; waitFor?: string[]; timeoutMs?: number }

export type ShellRunOptions = { command: string; waitFor?: string[]; timeoutMs?: number }

export type ShellWriteOptions = { data?: string; keys?: string[]; waitFor?: string[]; timeoutMs?: number }

export type ShellKillResult = { shell: ShellSummary; killed: boolean }

// How far the agent's hand reaches on this session: absent is read-only (the write tools are not offered), `gated`
// raises a permission card before every write, `allow` runs them without one beyond what the engine's own mode does.
export type ShellAgentWrite = 'gated' | 'allow'

export type ShellKeyOptions = { applicationCursorKeys?: boolean }

// The gateway-side directory a session's shell tools go through. Every method names the caller first, because one
// directory serves every session and a shell is owned by exactly one of them: another session's id reads as missing.
// `write` and `kill` refuse a shell the caller may not drive with an error that names the rule.
export interface ShellDirectory {
  list(from: string): Promise<ShellSummary[]>
  read(from: string, shellId: string, options?: ShellReadOptions): Promise<ShellReadResult | undefined>
  run(from: string, options: ShellRunOptions): Promise<ShellReadResult>
  write(from: string, shellId: string, options: ShellWriteOptions): Promise<ShellReadResult | undefined>
  kill(from: string, shellId: string): Promise<ShellKillResult | undefined>
  grant(from: string, shellId: string): Promise<ShellSummary | undefined>
}

// The one string every refusal returns, so the surface cannot be read as an existence oracle.
export const SHELL_REFUSAL = 'shell commands are not available on this session'

export const SHELL_WRITE_REFUSAL = 'the agent may not start, type into or kill shells on this session (shell.agentWrite is read-only)'

export const SHELL_KEYS_MAX = 64

const SHELL_DIRECTORY_SLOT = globalSlot<ShellDirectory>('workerdeck.shells.directory')

const CTRL_LETTERS = 'abcdefghijklmnopqrstuvwxyz'

const NAMED_KEYS: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  escape: '\x1b',
  esc: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  insert: '\x1b[2~',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  space: ' ',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
}

// Cursor keys have two encodings: CSI in normal mode, SS3 once a program has switched DECCKM on (most TUIs do).
const CURSOR_KEYS: Record<string, string> = { up: 'A', down: 'B', right: 'C', left: 'D', home: 'H', end: 'F' }

export const SHELL_KEY_NAMES: readonly string[] = [
  'enter',
  'tab',
  'shift-tab',
  'escape',
  'backspace',
  'delete',
  'insert',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'space',
  'f1 to f12',
  'ctrl-a to ctrl-z',
  'any single printable character',
]

const waitForShape = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(8)])
  .optional()
  .describe(
    'Wait until this text (or any of these) appears, the shell exits, or timeoutMs passes, then return the view. ' +
      'A plain case-sensitive substring, not a pattern.',
  )

const timeoutShape = z
  .number()
  .int()
  .min(0)
  .max(SHELL_WAIT_MAX_MS)
  .optional()
  .describe(`With waitFor: how long to wait (default ${SHELL_WAIT_DEFAULT_MS}, at most ${SHELL_WAIT_MAX_MS})`)

export const SHELL_TOOL_SHAPES = {
  shell_list: {
    description:
      'List the shells of this session: the commands your user ran with `$` and the ones you started with shell_run. Each ' +
      'has an id, a command, an owner (user or agent), whether it is still running, its exit code, how much output it ' +
      'produced and whether it is interactive (a program that redraws the screen). Call this before shell_read, ' +
      'shell_write or shell_kill to find the shell id.',
    shape: {},
  },
  shell_read: {
    description:
      'Read one shell\'s output. Use it to answer "what is the dev server printing now", to see more of a command ' +
      'whose output was summarised in the conversation, or with waitFor to block until a server is ready. Reading never ' +
      'writes to the shell and never interrupts it.',
    shape: {
      shellId: z.string().describe('The shell id from shell_list'),
      view: z
        .enum(['lines', 'screen'])
        .optional()
        .describe(
          'lines: the trailing lines of the output as plain text. screen: what the terminal shows right now, the only ' +
            'readable view of a program that redraws (a TUI, a dev server dashboard, a multi-line progress display). ' +
            'Defaults to screen for an interactive shell and lines otherwise.',
        ),
      tail: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          `With view lines: how many trailing lines to return (default ${SHELL_READ_DEFAULT_LINES}, capped at ${SHELL_READ_MAX_LINES})`,
        ),
      waitFor: z
        .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(8)])
        .optional()
        .describe(
          'Wait until the view contains this text (or any of these), the shell exits, or timeoutMs passes, then read. ' +
            'A plain case-sensitive substring, not a pattern. Text already there counts, so a server that was ready ' +
            'before the call returns at once.',
        ),
      timeoutMs: timeoutShape,
    },
  },
  shell_run: {
    description:
      "Start a shell command of your own in the session's working directory, in a real terminal (a PTY) that keeps " +
      'running after this call returns: a dev server, a watcher, a TUI. The result names the new shell id; use ' +
      'shell_read to watch it, shell_write to type into it and shell_kill to stop it. With waitFor the call blocks ' +
      'until the output contains that text (or the command exits or timeoutMs passes), so "start vite and wait for ' +
      "'ready in'\" is one call. This needs the user's approval and every shell you start is visible to them. For a " +
      'command that just runs and finishes, prefer your ordinary shell tool.',
    shape: {
      command: z
        .string()
        .min(1)
        .max(SHELL_COMMAND_MAX)
        .refine((command) => command.trim() !== '' && !command.includes('\0'), 'command must be non-empty text')
        .describe("The command line, run by the user's login shell in the session's working directory"),
      waitFor: waitForShape,
      timeoutMs: timeoutShape,
    },
  },
  shell_write: {
    description:
      'Type into a shell you started with shell_run: literal text in data, named keys in keys, or both (data is sent ' +
      'first, then the keys in order). To press Enter use keys ["enter"]; a "\\n" in data ends a line only for line-mode ' +
      `programs, not for a TUI. Key names: ${SHELL_KEY_NAMES.join(', ')}. ` +
      'With waitFor the call blocks until the shell prints that text AFTER your keystrokes (earlier output never ' +
      'counts), then returns the view, so "press r and wait for \'reloaded\'" is one call. Typing into a shell the ' +
      'user started is refused unless they granted it through shell_request_write.',
    shape: {
      shellId: z.string().describe('The shell id from shell_run or shell_list'),
      data: z.string().max(SHELL_INPUT_MAX).optional().describe('Literal text to type, sent as-is'),
      keys: z
        .array(z.string().min(1))
        .min(1)
        .max(SHELL_KEYS_MAX)
        .optional()
        .describe('Named keys to press after data, in order, e.g. ["r"], ["enter"], ["ctrl-c"], ["down", "down", "enter"]'),
      waitFor: waitForShape,
      timeoutMs: timeoutShape,
    },
  },
  shell_kill: {
    description:
      'Stop a shell you started with shell_run, killing its whole process tree. Use it when the user asks you to stop ' +
      'the server or when you are done with it. Killing a shell the user started is refused unless they granted it ' +
      'through shell_request_write.',
    shape: {
      shellId: z.string().describe('The shell id from shell_run or shell_list'),
    },
  },
  shell_request_write: {
    description:
      'Ask the user to let you type into (and kill) a shell THEY started with `$`, for example to answer a prompt in ' +
      'a script or to drive a TUI they launched. The user sees the shell and your reason and allows or denies; once ' +
      'allowed, shell_write and shell_kill work on it until the shell ends or the user revokes the grant. Never needed ' +
      'for a shell you started with shell_run.',
    shape: {
      shellId: z.string().describe('The id of a running shell the user started, from shell_list'),
      reason: z.string().min(1).max(500).describe('One sentence the user reads on the approval card: what you will type and why'),
    },
  },
} as const

export type ShellToolName = keyof typeof SHELL_TOOL_SHAPES

export const SHELL_READ_TOOL_NAMES: readonly ShellToolName[] = ['shell_list', 'shell_read']

export const SHELL_WRITE_TOOL_NAMES: readonly ShellToolName[] = ['shell_run', 'shell_write', 'shell_kill', 'shell_request_write']

export type ShellToolSpec = GatewayToolSpec<ShellToolName>

export type ShellToolOutput = GatewayToolOutput

export type ShellToolOptions = { write?: boolean }

const SHELL_TOOLS = defineToolFamily<typeof SHELL_TOOL_SHAPES, ShellDirectory>(SHELL_TOOL_SHAPES, {
  shell_list: async (shells, from) => {
    const rows = await shells.list(from)
    return { text: rows.length ? JSON.stringify(rows, null, 2) : 'No shell commands have run in this session.', isError: false }
  },
  shell_read: async (shells, from, { shellId, view, tail, waitFor, timeoutMs }) => {
    const result = await shells.read(from, shellId, { tail: clampShellTail(tail), view, waitFor: needles(waitFor), timeoutMs })
    if (!result) {
      return noSuchShell(shellId)
    }
    return { text: shellReadText(result), isError: false }
  },
  shell_run: async (shells, from, { command, waitFor, timeoutMs }) => {
    const result = await shells.run(from, { command, waitFor: needles(waitFor), timeoutMs })
    return { text: shellReadText(result, 'started'), isError: false }
  },
  shell_write: async (shells, from, { shellId, data, keys, waitFor, timeoutMs }) => {
    if (!data && !keys) {
      return invalidArguments('shell_write', 'give data, keys or both')
    }
    try {
      encodeShellKeys(keys ?? [])
    } catch (error) {
      return invalidArguments('shell_write', errorMessage(error))
    }
    const result = await shells.write(from, shellId, { data, keys, waitFor: needles(waitFor), timeoutMs })
    if (!result) {
      return noSuchShell(shellId)
    }
    return { text: shellReadText(result, 'typed'), isError: false }
  },
  shell_kill: async (shells, from, { shellId }) => {
    const result = await shells.kill(from, shellId)
    if (!result) {
      return noSuchShell(shellId)
    }
    return { text: shellKillText(result), isError: false }
  },
  shell_request_write: async (shells, from, { shellId }) => {
    const shell = await shells.grant(from, shellId)
    if (!shell) {
      return noSuchShell(shellId)
    }
    return {
      text: `granted: you may now type into and kill shell #${shell.ordinal} ${shell.id} ($ ${shell.command}) until it ends or the user revokes it`,
      isError: false,
    }
  },
})

export const SHELL_TOOL_NAMES = SHELL_TOOLS.names

// The tools a session is offered: the two read tools always, the three write tools only where the agent may write.
export function shellToolNames(write: boolean): ShellToolName[] {
  return write ? [...SHELL_READ_TOOL_NAMES, ...SHELL_WRITE_TOOL_NAMES] : [...SHELL_READ_TOOL_NAMES]
}

export function shellToolSpecs(write = false): ShellToolSpec[] {
  return SHELL_TOOLS.specs(shellToolNames(write))
}

export function isShellToolName(name: string): name is ShellToolName {
  return SHELL_TOOLS.is(name)
}

export function isShellWriteToolName(name: string): boolean {
  return SHELL_WRITE_TOOL_NAMES.includes(name as ShellToolName)
}

// The claude engine sees the tools under the workerdeck MCP server's prefix; codex and the provider under their own names.
export function shellWriteToolOf(toolName: string): ShellToolName | undefined {
  const bare = toolName.startsWith('mcp__') ? toolName.slice(toolName.indexOf('__', 5) + 2) : toolName
  return isShellWriteToolName(bare) ? (bare as ShellToolName) : undefined
}

// The bare shell tool behind an engine's tool name, read or write.
export function shellToolOf(toolName: string): ShellToolName | undefined {
  const bare = toolName.startsWith('mcp__') ? toolName.slice(toolName.indexOf('__', 5) + 2) : toolName
  return isShellToolName(bare) ? bare : undefined
}

// A grant is the user's decision about the user's own shell, so asking for one raises a card even under `allow`.
export function shellToolNeedsCard(toolName: string, agentWrite: ShellAgentWrite | undefined): boolean {
  const tool = shellWriteToolOf(toolName)
  if (tool === undefined || agentWrite === undefined) {
    return false
  }
  return agentWrite === 'gated' || tool === 'shell_request_write'
}

export function clampShellTail(tail: number | undefined): number {
  if (tail === undefined || !Number.isFinite(tail)) {
    return SHELL_READ_DEFAULT_LINES
  }
  return Math.max(1, Math.min(Math.floor(tail), SHELL_READ_MAX_LINES))
}

// The agent drives a shell it started, or one the user granted; the user's own shells are read-only to it.
export function agentMayWrite(shell: Pick<ShellInfo, 'sessionId' | 'owner' | 'agentWrite'>, from: string): boolean {
  return shell.sessionId === from && (shell.owner === 'agent' || shell.agentWrite === true)
}

export function shellOwnershipRefusal(shellId: string): string {
  return `shell ${shellId} was started by the user; the agent may only type into or kill shells it started, or one the user granted through shell_request_write`
}

export function shellWriteDeniedText(name: string, message: string | undefined): string {
  return `the user denied this ${name}${message ? `: ${message}` : ''}`
}

export function encodeShellKey(key: string, options: ShellKeyOptions = {}): string | undefined {
  const chars = [...key]
  if (chars.length === 1) {
    const code = key.codePointAt(0)!
    return code < 0x20 || code === 0x7f ? undefined : key
  }
  const name = key
    .toLowerCase()
    .replace(/\+/g, '-')
    .replace(/^control-/, 'ctrl-')
    .replace(/^c-/, 'ctrl-')
  const named = NAMED_KEYS[name]
  if (named !== undefined) {
    return named
  }
  const cursor = CURSOR_KEYS[name]
  if (cursor !== undefined) {
    return `\x1b${options.applicationCursorKeys ? 'O' : '['}${cursor}`
  }
  if (name.startsWith('ctrl-') && name.length === 6) {
    const index = CTRL_LETTERS.indexOf(name[5]!)
    if (index !== -1) {
      return String.fromCharCode(index + 1)
    }
  }
  return undefined
}

export function encodeShellKeys(keys: readonly string[], options: ShellKeyOptions = {}): string {
  let out = ''
  for (const key of keys) {
    const encoded = encodeShellKey(key, options)
    if (encoded === undefined) {
      throw new Error(`unknown key ${JSON.stringify(key)}; use one of ${SHELL_KEY_NAMES.join(', ')}`)
    }
    out += encoded
  }
  return out
}

export function shellSummary(info: ShellInfo): ShellSummary {
  return {
    id: info.id,
    ordinal: info.ordinal,
    command: info.command,
    label: info.label,
    cwd: info.cwd,
    owner: info.owner,
    status: info.status,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    exitCode: info.exitCode,
    endReason: info.endReason,
    bytes: info.bytes,
    capped: info.capped,
    interactive: info.interactive,
    agentWrite: info.agentWrite,
  }
}

// The text view's trailing lines, never raw bytes: what a person would see on the last screen of that terminal.
export function shellTail(
  text: string,
  tail: number,
): { view: 'lines'; text: string; lines: number; totalLines: number; truncated: boolean } {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const all = body.length === 0 ? [] : body.split('\n')
  const kept = all.slice(Math.max(0, all.length - tail))
  return { view: 'lines', text: kept.join('\n'), lines: kept.length, totalLines: all.length, truncated: kept.length < all.length }
}

export async function runShellTool(
  shells: ShellDirectory,
  from: string,
  name: string,
  args: unknown,
  options: ShellToolOptions = {},
): Promise<ShellToolOutput> {
  if (!isShellToolName(name)) {
    return { text: `unknown shell tool: ${name}`, isError: true }
  }
  if (isShellWriteToolName(name) && options.write !== true) {
    return { text: SHELL_WRITE_REFUSAL, isError: true }
  }
  return SHELL_TOOLS.run(shells, from, name, args)
}

function noSuchShell(shellId: string): ShellToolOutput {
  return { text: `no such shell: ${shellId}`, isError: true }
}

function needles(waitFor: string | string[] | undefined): string[] | undefined {
  if (waitFor === undefined) {
    return undefined
  }
  return typeof waitFor === 'string' ? [waitFor] : waitFor
}

export function shellReadText(result: ShellReadResult, verb?: 'started' | 'typed'): string {
  const { shell } = result
  const scope =
    result.view === 'screen'
      ? 'the current screen'
      : result.truncated
        ? `showing the last ${result.lines} of ${result.totalLines} lines`
        : `showing all ${result.lines} lines`
  const parts = [`$ ${shell.command}`, ...(verb ? [verb] : []), shellState(shell), ...(shell.interactive ? ['interactive'] : []), scope]
  if (result.wait) {
    parts.push(waitText(result.wait))
  }
  const head = `[shell #${shell.ordinal} ${shell.id}: ${parts.join(', ')}]`
  return result.text ? `${head}\n${result.text}` : `${head}\n(no output)`
}

export function shellKillText(result: ShellKillResult): string {
  const { shell } = result
  const name = `shell #${shell.ordinal} ${shell.id} ($ ${shell.command})`
  return result.killed ? `killed ${name}` : `${name} had already ended (${shellState(shell)})`
}

function waitText(wait: ShellWait): string {
  const seconds = `${(wait.ms / 1000).toFixed(1)}s`
  switch (wait.outcome) {
    case 'matched': {
      return `found ${JSON.stringify(wait.match)} after ${seconds}`
    }
    case 'exited': {
      return `the shell ended before the text appeared (${seconds})`
    }
    case 'timeout': {
      return `the text did not appear within ${seconds}`
    }
  }
}

function shellState(shell: ShellSummary): string {
  if (shell.status === 'running') {
    return 'still running'
  }
  if (shell.exitCode !== undefined) {
    return `exited ${shell.exitCode}`
  }
  return `ended (${shell.endReason ?? 'exit'})`
}

export function installShellDirectory(directory: ShellDirectory | undefined): void {
  SHELL_DIRECTORY_SLOT.install(directory)
}

export function installedShellDirectory(): ShellDirectory | undefined {
  return SHELL_DIRECTORY_SLOT.installed()
}

export function shellDirectoryHandle(own?: () => ShellDirectory | undefined): ShellDirectory {
  return lateBoundDirectory<ShellDirectory>(['list', 'read', 'run', 'write', 'kill', 'grant'], SHELL_DIRECTORY_SLOT, own, SHELL_REFUSAL)
}
