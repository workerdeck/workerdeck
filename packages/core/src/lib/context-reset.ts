import { z } from 'zod'
import type { ClearContextOptions } from '../runner-interface.ts'
import { defineToolFamily, globalSlot, lateBoundDirectory, type GatewayToolOutput } from './gateway-tools.ts'

export type ContextResetRequest = { prompt: string; reason: string }

export interface ContextResetDirectory {
  request(sessionId: string, request: ContextResetRequest): Promise<string>
}

export const CONTEXT_RESET_TOOL = 'context_reset'
export const CONTEXT_RESET_PROMPT_MAX = 16_000
export const CONTEXT_RESET_REASON_MAX = 200

const CONTEXT_RESET_SLOT = globalSlot<ContextResetDirectory>('workerdeck.contextReset.directory')

const CONTEXT_RESET_TOOL_SHAPES = {
  [CONTEXT_RESET_TOOL]: {
    description:
      'Clear your own conversation and continue in a fresh context window. The reset never happens mid-turn: it runs once ' +
      'your current turn ends, so end your turn right after calling this. The new conversation starts with `prompt` as its ' +
      'first message and nothing else from this conversation survives, so first save anything worth keeping to files, then ' +
      'write `prompt` as complete instructions to your future self: the goal, where the handoff notes are, and the next step. ' +
      'Use it during long unattended work when session_info shows the context filling up. `reason` is one short line shown ' +
      'to the human. The gateway rate-limits resets and may refuse one.',
    shape: {
      prompt: z.string().trim().min(1).max(CONTEXT_RESET_PROMPT_MAX).describe('The first message of the fresh conversation'),
      reason: z.string().trim().min(1).max(CONTEXT_RESET_REASON_MAX).describe('Why you are resetting, one short line'),
    },
  },
} as const

const CONTEXT_RESET_TOOLS = defineToolFamily<typeof CONTEXT_RESET_TOOL_SHAPES, ContextResetDirectory>(CONTEXT_RESET_TOOL_SHAPES, {
  [CONTEXT_RESET_TOOL]: async (directory, from, input) => ({ text: await directory.request(from, input), isError: false }),
})

export const CONTEXT_RESET_TOOL_SHAPE = CONTEXT_RESET_TOOL_SHAPES[CONTEXT_RESET_TOOL]

export function isContextResetToolName(name: string): name is typeof CONTEXT_RESET_TOOL {
  return CONTEXT_RESET_TOOLS.is(name)
}

export function runContextResetTool(directory: ContextResetDirectory, from: string, args: unknown): Promise<GatewayToolOutput> {
  return CONTEXT_RESET_TOOLS.run(directory, from, CONTEXT_RESET_TOOL, args)
}

export function installContextResetDirectory(directory: ContextResetDirectory | undefined): void {
  CONTEXT_RESET_SLOT.install(directory)
}

export function contextResetDirectoryHandle(own?: () => ContextResetDirectory | undefined): ContextResetDirectory {
  return lateBoundDirectory<ContextResetDirectory>(['request'], CONTEXT_RESET_SLOT, own, 'context reset is not available on this gateway')
}

export function agentResetFields(options: ClearContextOptions | undefined): { agentReason?: string } {
  return options?.agentReason === undefined ? {} : { agentReason: options.agentReason }
}
