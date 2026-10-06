import { z } from 'zod'
import { STATUS_LABEL_EMOJI_MAX, STATUS_LABEL_TEXT_MAX, type StatusLabel, type StatusLabelInput } from '@workerdeck/protocol'
import { defineToolFamily, type GatewayToolOutput } from './gateway-tools.ts'

export type StatusLabelSink = (label: StatusLabelInput | null) => StatusLabel | null

export const SET_STATUS_TOOL = 'set_status'

const SET_STATUS_TOOL_SHAPES = {
  [SET_STATUS_TOOL]: {
    description:
      'Set the one-line status shown under your name in the human\'s session list, like a chat status: what you are doing, ' +
      'waiting on, or need from them ("waiting on CI", "blocked: needs an API key", "done, ready for review"). It stays ' +
      'until you change it and clears when your conversation is reset. Pass an empty `text` to clear it. Keep it short and ' +
      'current; it is a glance, not a log.',
    shape: {
      text: z.string().max(STATUS_LABEL_TEXT_MAX).describe('The status line; empty clears it'),
      emoji: z.string().max(STATUS_LABEL_EMOJI_MAX).optional().describe('One emoji shown before the text'),
    },
  },
} as const

const SET_STATUS_TOOLS = defineToolFamily<typeof SET_STATUS_TOOL_SHAPES, StatusLabelSink>(SET_STATUS_TOOL_SHAPES, {
  [SET_STATUS_TOOL]: async (sink, _from, input) => {
    const text = input.text.replace(/\s+/g, ' ').trim()
    const emoji = input.emoji?.trim()
    const label = sink(text ? (emoji ? { text, emoji } : { text }) : null)
    return { text: label ? `Status set: ${label.emoji ? `${label.emoji} ` : ''}${label.text}` : 'Status cleared', isError: false }
  },
})

export const SET_STATUS_TOOL_SHAPE = SET_STATUS_TOOL_SHAPES[SET_STATUS_TOOL]

export function isSetStatusToolName(name: string): name is typeof SET_STATUS_TOOL {
  return SET_STATUS_TOOLS.is(name)
}

export function runSetStatusTool(sink: StatusLabelSink, from: string, args: unknown): Promise<GatewayToolOutput> {
  return SET_STATUS_TOOLS.run(sink, from, SET_STATUS_TOOL, args)
}
