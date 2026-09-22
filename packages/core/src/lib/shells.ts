import { z } from 'zod'
import {
  SHELL_READ_DEFAULT_LINES,
  SHELL_READ_MAX_LINES,
  type ShellEndReason,
  type ShellInfo,
  type ShellOwner,
  type ShellStatus,
} from '@workerdeck/protocol'

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
}

export type ShellReadResult = {
  shell: ShellSummary
  text: string
  lines: number
  totalLines: number
  truncated: boolean
}

export type ShellReadOptions = { tail?: number }

// The gateway-side directory a session's shell tools read through. Every method names the caller first, because one
// directory serves every session and a shell is owned by exactly one of them: another session's id reads as missing.
export interface ShellDirectory {
  list(from: string): Promise<ShellSummary[]>
  read(from: string, shellId: string, options?: ShellReadOptions): Promise<ShellReadResult | undefined>
}

// The one string every refusal returns, so the surface cannot be read as an existence oracle.
export const SHELL_REFUSAL = 'shell commands are not available on this session'

const SHELL_DIRECTORY_SLOT = Symbol.for('workerdeck.shells.directory')

export const SHELL_TOOL_SHAPES = {
  shell_list: {
    description:
      'List the shell commands your user has run in this session with `$`: id, command, whether it is still running, its exit ' +
      'code and how much output it produced. Call this before shell_read to find the shell id.',
    shape: {},
  },
  shell_read: {
    description:
      'Read the end of one shell command\'s output, as a terminal would show it. Use it to answer "what is the dev server ' +
      'printing now" or to see more of a command whose output was summarised in the conversation. Reading never writes to ' +
      'the shell and never interrupts it.',
    shape: {
      shellId: z.string().describe('The shell id from shell_list'),
      tail: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`How many trailing lines to return (default ${SHELL_READ_DEFAULT_LINES}, capped at ${SHELL_READ_MAX_LINES})`),
    },
  },
} as const

export type ShellToolName = keyof typeof SHELL_TOOL_SHAPES

export const SHELL_TOOL_NAMES = Object.keys(SHELL_TOOL_SHAPES) as ShellToolName[]

export type ShellToolSpec = { name: ShellToolName; description: string; inputSchema: Record<string, unknown> }

export type ShellToolOutput = { text: string; isError: boolean }

export function shellToolSpecs(): ShellToolSpec[] {
  return SHELL_TOOL_NAMES.map((name) => {
    const { description, shape } = SHELL_TOOL_SHAPES[name]
    return { name, description, inputSchema: z.toJSONSchema(z.object(shape)) as Record<string, unknown> }
  })
}

export function isShellToolName(name: string): name is ShellToolName {
  return Object.hasOwn(SHELL_TOOL_SHAPES, name)
}

export function clampShellTail(tail: number | undefined): number {
  if (tail === undefined || !Number.isFinite(tail)) {
    return SHELL_READ_DEFAULT_LINES
  }
  return Math.max(1, Math.min(Math.floor(tail), SHELL_READ_MAX_LINES))
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
  }
}

// The text view's trailing lines, never raw bytes: what a person would see on the last screen of that terminal.
export function shellTail(text: string, tail: number): { text: string; lines: number; totalLines: number; truncated: boolean } {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  const all = body.length === 0 ? [] : body.split('\n')
  const kept = all.slice(Math.max(0, all.length - tail))
  return { text: kept.join('\n'), lines: kept.length, totalLines: all.length, truncated: kept.length < all.length }
}

export async function runShellTool(shells: ShellDirectory, from: string, name: string, args: unknown): Promise<ShellToolOutput> {
  if (!isShellToolName(name)) {
    return { text: `unknown shell tool: ${name}`, isError: true }
  }
  try {
    switch (name) {
      case 'shell_list': {
        const rows = await shells.list(from)
        return { text: rows.length ? JSON.stringify(rows, null, 2) : 'No shell commands have run in this session.', isError: false }
      }
      case 'shell_read': {
        const input = z.object(SHELL_TOOL_SHAPES.shell_read.shape).safeParse(args ?? {})
        if (!input.success) {
          return invalidArguments(name, input.error)
        }
        const result = await shells.read(from, input.data.shellId, { tail: clampShellTail(input.data.tail) })
        if (!result) {
          return { text: `no such shell: ${input.data.shellId}`, isError: true }
        }
        return { text: shellReadText(result), isError: false }
      }
    }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true }
  }
}

function invalidArguments(name: string, error: z.ZodError): ShellToolOutput {
  return {
    text: `invalid arguments for ${name}: ${error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`,
    isError: true,
  }
}

export function shellReadText(result: ShellReadResult): string {
  const { shell } = result
  const scope = result.truncated ? `showing the last ${result.lines} of ${result.totalLines} lines` : `showing all ${result.lines} lines`
  const head = `[shell #${shell.ordinal} ${shell.id}: $ ${shell.command}, ${shellState(shell)}, ${scope}]`
  return result.text ? `${head}\n${result.text}` : `${head}\n(no output)`
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

// The one directory in the process, installed by the gateway and read by every runner through this handle. A hot
// reload keeps the old generation's runners alive with the config they were born with; resolving the directory per
// call, rather than capturing it, is what lets a carried session keep reaching the registry that now holds its shells.
export function installShellDirectory(directory: ShellDirectory | undefined): void {
  ;(globalThis as Record<symbol, unknown>)[SHELL_DIRECTORY_SLOT] = directory
}

export function installedShellDirectory(): ShellDirectory | undefined {
  return (globalThis as Record<symbol, unknown>)[SHELL_DIRECTORY_SLOT] as ShellDirectory | undefined
}

export function shellDirectoryHandle(): ShellDirectory {
  const resolve = (): ShellDirectory => {
    const directory = installedShellDirectory()
    if (!directory) {
      throw new Error(SHELL_REFUSAL)
    }
    return directory
  }
  return {
    list: async (from) => resolve().list(from),
    read: async (from, shellId, options) => resolve().read(from, shellId, options),
  }
}
