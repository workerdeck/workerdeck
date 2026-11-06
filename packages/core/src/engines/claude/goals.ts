import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { GOAL_CLEAR_ALIASES, type ApiMessage, type GoalSetter, type SessionGoal, type TextBlock } from '@workerdeck/protocol'

export type GoalStatus = { met: boolean; sentinel?: boolean; failed?: boolean; condition: string; reason?: string; at?: number }

export type GoalStatusFn = (sdkSessionId: string, options: { configDir: string }) => Promise<GoalStatus[] | undefined>

export type GoalReply = { kind: 'set'; text: string } | { kind: 'cleared' } | { kind: 'status' } | { kind: 'refused'; message: string }

const SET = 'Goal set: '
const CLEARED = 'Goal cleared: '
const NONE = 'No goal set'
const STATUS = ['Goal active: ', 'No goal set. Usage:']
const FEEDBACK = 'Stop hook feedback:\n['

export const GOAL_CLEAR_COMMAND = '/goal clear'

export function goalCommand(text: string): string {
  return `/goal ${text}`
}

export function withGoalSettings(settings: Options['settings']): Options['settings'] {
  if (typeof settings === 'string') {
    if (!settings.trimStart().startsWith('{')) {
      return settings
    }
    settings = JSON.parse(settings) as Exclude<Options['settings'], string | undefined>
  }
  return { ...settings, modelProposedGoals: 'disabled' } as Options['settings']
}

export function typedGoalArgs(text: string): string | undefined {
  const match = /^\s*\/goal(?:\s+([\s\S]*))?$/.exec(text)
  return match ? (match[1] ?? '').trim() : undefined
}

export function goalCommandRun(msg: unknown): { args: string } | undefined {
  const run = (msg as { local_command_run?: { command?: unknown; args?: unknown } }).local_command_run
  return run?.command === 'goal' ? { args: typeof run.args === 'string' ? run.args.trim() : '' } : undefined
}

export function isClearArgs(args: string): boolean {
  return GOAL_CLEAR_ALIASES.has(args.toLowerCase())
}

export function parseGoalReply(text: string, args: string): GoalReply {
  const line = text.trim()
  if (args === '' || STATUS.some((prefix) => line.startsWith(prefix))) {
    return { kind: 'status' }
  }
  if (isClearArgs(args)) {
    return line.startsWith(CLEARED) || line === NONE ? { kind: 'cleared' } : { kind: 'refused', message: line }
  }
  return line.startsWith(SET) ? { kind: 'set', text: line.slice(SET.length) } : { kind: 'refused', message: line }
}

export function messageText(message: ApiMessage): string {
  const content = message.content
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

// A Stop hook of the user's own settings reports in the same shape, so only the goal's own condition counts.
export function goalCheckReason(message: ApiMessage, condition: string): string | undefined {
  const text = messageText(message)
  const head = `${FEEDBACK}${condition}]: `
  return text.startsWith(head) ? text.slice(head.length).trim() : undefined
}

export function activeGoal(text: string, setBy: GoalSetter, setAt = Date.now()): SessionGoal {
  return { text, state: 'active', setAt, setBy, checks: 0 }
}

// The state the engine's last `goal_status` for this goal implies; `undefined` when it says nothing new.
export function goalVerdict(goal: SessionGoal, statuses: readonly GoalStatus[]): SessionGoal | null | undefined {
  const last = statuses.at(-1)
  if (!last || last.condition !== goal.text) {
    return undefined
  }
  if (last.met && last.sentinel) {
    return null
  }
  if (last.met) {
    return { ...goal, state: 'met', ...reasonOf(last) }
  }
  if (last.failed) {
    return { ...goal, state: 'failed', ...reasonOf(last) }
  }
  if (last.reason !== undefined && last.reason !== goal.lastReason) {
    return { ...goal, state: 'active', lastReason: last.reason }
  }
  return undefined
}

function reasonOf(status: GoalStatus): { lastReason?: string } {
  return status.reason === undefined ? {} : { lastReason: status.reason }
}

// What the CLI restores on resume: the last `goal_status` names a goal it brings back unless that one is met, failed
// or cleared (a clear writes `met: true, sentinel: true`).
export function restorableGoal(
  statuses: readonly GoalStatus[],
): { text: string; setAt?: number; checks: number; lastReason?: string } | undefined {
  const last = statuses.at(-1)
  if (!last || last.met || last.failed || !last.condition) {
    return undefined
  }
  let set = statuses.length - 1
  while (set >= 0 && !(statuses[set]!.sentinel === true && !statuses[set]!.met && statuses[set]!.condition === last.condition)) {
    set--
  }
  const since = statuses.slice(set + 1).filter((status) => status.condition === last.condition && !status.sentinel)
  return {
    text: last.condition,
    ...(set >= 0 && statuses[set]!.at !== undefined ? { setAt: statuses[set]!.at } : {}),
    checks: since.length,
    ...(last.reason === undefined ? {} : { lastReason: last.reason }),
  }
}

export function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

const CHUNK = 1 << 20
const NEWLINE = 0x0a
const MARK = Buffer.from('"goal_status"')

// Read-only, and only from the end: the statuses since the latest set (inclusive), oldest first. The project
// directory is the CLI's own slug of the cwd, so it is found by listing, never re-derived.
export async function readGoalStatuses(sdkSessionId: string, options: { configDir: string }): Promise<GoalStatus[] | undefined> {
  const path = await findTranscript(sdkSessionId, options.configDir)
  return path === undefined ? undefined : await tailGoalStatuses(path)
}

async function findTranscript(sdkSessionId: string, configDir: string): Promise<string | undefined> {
  const root = join(configDir, 'projects')
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    const path = join(root, dir, `${sdkSessionId}.jsonl`)
    if (await isFile(path)) {
      return path
    }
  }
  return undefined
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function tailGoalStatuses(path: string): Promise<GoalStatus[] | undefined> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch {
    return undefined
  }
  try {
    const found: GoalStatus[] = []
    let end = (await handle.stat()).size
    let carry = Buffer.alloc(0)
    while (end > 0) {
      const start = Math.max(0, end - CHUNK)
      const chunk = Buffer.alloc(end - start)
      await handle.read(chunk, 0, chunk.length, start)
      end = start
      const data = Buffer.concat([chunk, carry])
      const first = start === 0 ? -1 : data.indexOf(NEWLINE)
      if (start > 0 && first === -1) {
        carry = data
        continue
      }
      carry = start === 0 ? Buffer.alloc(0) : data.subarray(0, first + 1)
      const statuses = goalStatusesIn(data.subarray(first + 1))
      for (let i = statuses.length - 1; i >= 0; i--) {
        const status = statuses[i]!
        found.unshift(status)
        if (status.sentinel && !status.met) {
          return found
        }
      }
    }
    return found
  } catch {
    return undefined
  } finally {
    await handle.close()
  }
}

function goalStatusesIn(lines: Buffer): GoalStatus[] {
  const statuses: GoalStatus[] = []
  let from = 0
  while (from < lines.length) {
    const at = lines.indexOf(NEWLINE, from)
    const line = lines.subarray(from, at === -1 ? lines.length : at)
    from = at === -1 ? lines.length : at + 1
    const status = line.indexOf(MARK) === -1 ? undefined : goalStatusOf(line.toString('utf8'))
    if (status) {
      statuses.push(status)
    }
  }
  return statuses
}

function goalStatusOf(line: string): GoalStatus | undefined {
  let entry: { type?: unknown; timestamp?: unknown; attachment?: Record<string, unknown> }
  try {
    entry = JSON.parse(line) as typeof entry
  } catch {
    return undefined
  }
  const a = entry.attachment
  if (entry.type !== 'attachment' || a?.type !== 'goal_status' || typeof a.condition !== 'string') {
    return undefined
  }
  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return {
    met: a.met === true,
    ...(a.sentinel === true ? { sentinel: true } : {}),
    ...(a.failed === true ? { failed: true } : {}),
    condition: a.condition,
    ...(typeof a.reason === 'string' ? { reason: a.reason } : {}),
    ...(Number.isFinite(at) ? { at } : {}),
  }
}

const COMMAND = /^\s*<command-name>\/goal<\/command-name>/

// A resumed transcript keeps every `/goal`, host ones too, as the raw command row. It holds no outcome (the CLI may have
// refused it), so it replays hidden; the goal's state comes from the record and the transcript's `goal_status`.
export function isReplayedGoalCommand(message: ApiMessage): boolean {
  const content = message.content
  const text =
    typeof content === 'string' ? content : content.length === 1 && content[0]?.type === 'text' ? (content[0] as TextBlock).text : undefined
  return text !== undefined && COMMAND.test(text)
}
