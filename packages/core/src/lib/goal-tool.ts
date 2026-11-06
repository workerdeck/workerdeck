import { z } from 'zod'
import { GOAL_TEXT_MAX } from '@workerdeck/protocol'
import { defineToolFamily, globalSlot, lateBoundDirectory, type GatewayToolOutput } from './gateway-tools.ts'

export type GoalToolTarget = { target?: string }

// The gateway's side of the `goal_*` tools. `from` is the calling session; `target` (a session id or agent name)
// absent means the caller itself. The directory owns reach (self, or a lead on its members) and provenance (an
// agent never changes a goal a human set) and answers with the line the model reads; a refusal throws.
export interface GoalDirectory {
  get(from: string, request: GoalToolTarget): Promise<string>
  set(from: string, request: GoalToolTarget & { text: string; tokenBudget?: number | null }): Promise<string>
  clear(from: string, request: GoalToolTarget): Promise<string>
  pause(from: string, request: GoalToolTarget & { paused: boolean }): Promise<string>
}

export const GOAL_TOOL_NAMES = ['goal_get', 'goal_set', 'goal_clear', 'goal_pause'] as const

const GOAL_SLOT = globalSlot<GoalDirectory>('workerdeck.goals.directory')

export type GoalToolName = (typeof GOAL_TOOL_NAMES)[number]

const target = z
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('A team member (session id or agent name) when you lead a team; omit for your own goal')

const GOAL_TOOL_SHAPES = {
  goal_get: {
    description: 'Read the current goal of your session (or of a member of the team you lead): text, state, checks, last reason.',
    shape: { target },
  },
  goal_set: {
    description:
      'Set a goal: a condition the engine keeps working toward across turns until it is met. Replaces a goal an agent ' +
      'set; a goal the human set cannot be replaced by an agent. On your own session the goal takes effect after your ' +
      'current turn ends. `tokenBudget` caps the tokens the goal may spend (engines without budgets refuse it).',
    shape: {
      text: z.string().trim().min(1).max(GOAL_TEXT_MAX).describe('The condition, checkable from the work itself'),
      tokenBudget: z.number().int().positive().nullable().optional().describe('Token cap for the goal; null removes it'),
      target,
    },
  },
  goal_clear: {
    description: 'Clear the goal an agent set. A goal the human set cannot be cleared by an agent.',
    shape: { target },
  },
  goal_pause: {
    description:
      'Pause (`paused: true`) or resume a goal an agent set. Pausing lets the running turn finish and starts no more ' +
      'goal turns. Engines without pause refuse it.',
    shape: { paused: z.boolean().describe('true pauses, false resumes'), target },
  },
} as const

const GOAL_TOOLS = defineToolFamily<typeof GOAL_TOOL_SHAPES, GoalDirectory>(GOAL_TOOL_SHAPES, {
  goal_get: async (directory, from, input) => ({ text: await directory.get(from, input), isError: false }),
  goal_set: async (directory, from, input) => ({ text: await directory.set(from, input), isError: false }),
  goal_clear: async (directory, from, input) => ({ text: await directory.clear(from, input), isError: false }),
  goal_pause: async (directory, from, input) => ({ text: await directory.pause(from, input), isError: false }),
})

export const GOAL_TOOL_SHAPE = GOAL_TOOL_SHAPES

export function isGoalToolName(name: string): name is GoalToolName {
  return GOAL_TOOLS.is(name)
}

export function runGoalTool(directory: GoalDirectory, from: string, name: GoalToolName, args: unknown): Promise<GatewayToolOutput> {
  return GOAL_TOOLS.run(directory, from, name, args)
}

export function installGoalDirectory(directory: GoalDirectory | undefined): void {
  GOAL_SLOT.install(directory)
}

export function goalDirectoryHandle(own?: () => GoalDirectory | undefined): GoalDirectory {
  return lateBoundDirectory<GoalDirectory>(['get', 'set', 'clear', 'pause'], GOAL_SLOT, own, 'goals are not available on this gateway')
}
