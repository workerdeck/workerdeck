import { z } from 'zod'
import {
  AGENT_STATUS_EXAMPLES,
  STATUS_LABEL_TEXT_MAX,
  agentStatusRefusal,
  type StatusLabel,
  type StatusLabelInput,
} from '@workerdeck/protocol'
import { defineToolFamily, type GatewayToolOutput } from './gateway-tools.ts'

export type StatusLabelSink = (label: StatusLabelInput | null) => StatusLabel | null

export const SET_STATUS_TOOL = 'set_status'

const EXAMPLES = AGENT_STATUS_EXAMPLES.map((example) => `"${example}"`).join(', ')

export const SET_STATUS_GUIDANCE =
  'Keep your session-list status current with the `set_status` tool: set it when you start a task, when you are blocked ' +
  `or waiting on someone, and when you finish. It is Verb Noun, at most three words, no emoji (${EXAMPLES}). Pass ` +
  "`waitingOn: 'human'` only when you cannot continue without a person (a decision, access, a credential); it flags " +
  'you as needing attention until the person messages you. Set a new status without it as soon as you continue.'

const SET_STATUS_TOOL_SHAPES = {
  [SET_STATUS_TOOL]: {
    description:
      "Set the status shown beside your name in the human's session list. It is Verb Noun, at most three words, no " +
      `emoji: ${EXAMPLES}. Set it when you start a task, when you are blocked or waiting, and when you finish; it stays ` +
      'until you change it and clears when your conversation is reset. Pass an empty `text` to clear it.',
    shape: {
      text: z.string().max(STATUS_LABEL_TEXT_MAX).describe('Verb Noun, at most three words, no emoji; empty clears it'),
      waitingOn: z
        .enum(['human'])
        .optional()
        .describe(
          "'human' only when you cannot continue without a person; a message from the person or a status set without it clears the flag",
        ),
    },
  },
} as const

const SET_STATUS_TOOLS = defineToolFamily<typeof SET_STATUS_TOOL_SHAPES, StatusLabelSink>(SET_STATUS_TOOL_SHAPES, {
  [SET_STATUS_TOOL]: async (sink, _from, input) => {
    const text = input.text.replace(/\s+/g, ' ').trim()
    const refusal = agentStatusRefusal(text)
    if (refusal) {
      return { text: `Status not set (${refusal}): use Verb Noun, at most three words, no emoji, e.g. ${EXAMPLES}.`, isError: true }
    }
    const label = sink(text ? { text, ...(input.waitingOn ? { waitingOn: input.waitingOn } : {}) } : null)
    const waiting = label?.waitingOn ? ' (waiting on the human)' : ''
    return { text: label ? `Status set: ${label.text}${waiting}` : 'Status cleared', isError: false }
  },
})

export const SET_STATUS_TOOL_SHAPE = SET_STATUS_TOOL_SHAPES[SET_STATUS_TOOL]

export function isSetStatusToolName(name: string): name is typeof SET_STATUS_TOOL {
  return SET_STATUS_TOOLS.is(name)
}

export function runSetStatusTool(sink: StatusLabelSink, from: string, args: unknown): Promise<GatewayToolOutput> {
  return SET_STATUS_TOOLS.run(sink, from, SET_STATUS_TOOL, args)
}
