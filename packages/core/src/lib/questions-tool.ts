import { z } from 'zod'
import {
  QUESTION_ANSWER_MAX,
  QUESTION_CLOSE_REASONS,
  QUESTION_CONTEXT_MAX,
  QUESTION_KINDS,
  QUESTION_LINK_MAX,
  QUESTION_LINKS_MAX,
  QUESTION_NOTE_MAX,
  QUESTION_OPTION_DETAIL_MAX,
  QUESTION_OPTION_LABEL_MAX,
  QUESTION_OPTIONS_MAX,
  QUESTION_ROUND_MAX,
  QUESTION_STATUSES,
  QUESTION_TITLE_MAX,
  QUESTION_WAITING_MAX,
} from '@workerdeck/protocol'
import { defineToolFamily, globalSlot, lateBoundDirectory, type GatewayToolOutput } from './gateway-tools.ts'

const QUESTION_SLOT = globalSlot<QuestionDirectory>('workerdeck.questions.directory')

const OPTION = z.object({
  key: z.string().trim().min(1).max(8).describe('Short key the human picks, like "A" or "1"'),
  label: z.string().trim().min(1).max(QUESTION_OPTION_LABEL_MAX),
  detail: z.string().max(QUESTION_OPTION_DETAIL_MAX).optional().describe('Consequences or trade-offs of this option'),
})

const ITEM_FIELDS = {
  kind: z
    .enum(QUESTION_KINDS)
    .optional()
    .describe('decision (default): pick or answer; action: something the human must do and confirm; fyi: no answer needed'),
  title: z.string().trim().min(1).max(QUESTION_TITLE_MAX).describe('One line the human reads first'),
  context: z
    .string()
    .max(QUESTION_CONTEXT_MAX)
    .optional()
    .describe('Markdown: what the human needs to answer without opening anything else'),
  options: z.array(OPTION).max(QUESTION_OPTIONS_MAX).optional(),
  recommend: z.string().trim().max(8).optional().describe('The option key you recommend'),
  why: z.string().max(QUESTION_NOTE_MAX).optional().describe('Why you recommend it'),
  blocking: z
    .string()
    .max(QUESTION_NOTE_MAX)
    .optional()
    .describe('What waits on the answer: a branch, a commit, an uncommitted change, a file'),
  waiting: z.array(z.string().trim().min(1)).max(QUESTION_WAITING_MAX).optional().describe('Other session ids to tell when it is answered'),
  links: z.array(z.string().trim().min(1).max(QUESTION_LINK_MAX)).max(QUESTION_LINKS_MAX).optional().describe('Paths or URLs'),
  round: z.string().trim().max(QUESTION_ROUND_MAX).optional().describe('Groups items asked together, like "pricing review"'),
}

const QUESTION_TOOL_SHAPES = {
  questions_ask: {
    description:
      "Post an item to your team's question board, where the human reads and answers open questions without being interrupted. " +
      'Use it instead of asking in chat for anything that can wait: a decision, an action only the human can take, or an fyi. ' +
      'Give the context needed to answer cold, then options with your recommendation so answering is one pick. When the ' +
      "human answers you get a message with the answer; keep working on something else meanwhile. A team member's item " +
      'goes to its lead first, who may publish, edit, merge or reject it. Pass `parent` to follow up on an answered item.',
    shape: {
      ...ITEM_FIELDS,
      parent: z.number().int().positive().optional().describe('The item this follows up on (#n)'),
    },
  },
  questions_list: {
    description:
      "Read your team's question board: open items, drafts waiting for the lead, and the dated answered log you can cite by #n. " +
      'Check it after a reset or a long break: an answer that could not reach you is kept here.',
    shape: {
      filter: z.enum(['all', 'mine', 'waiting']).optional().describe('mine: you asked it; waiting: you asked it or wait on it'),
      status: z.enum(QUESTION_STATUSES).optional(),
      n: z.number().int().positive().optional().describe('Read one item in full'),
    },
  },
  questions_update: {
    description:
      'Edit an unanswered item you asked (or, as the lead, any item on your board) so it stays current when the code moves. ' +
      'Only the fields you pass change. The lead publishes a draft with `publish: true`.',
    shape: {
      n: z.number().int().positive(),
      ...ITEM_FIELDS,
      title: ITEM_FIELDS.title.optional(),
      publish: z.boolean().optional().describe('Lead only: move a draft to the human'),
    },
  },
  questions_close: {
    description:
      'Close an item without an answer: resolved (no longer needed), superseded by another item, or withdrawn. The lead ' +
      'rejects a draft with `rejected` and a note the asker gets.',
    shape: {
      n: z.number().int().positive(),
      reason: z.enum(QUESTION_CLOSE_REASONS),
      note: z.string().max(QUESTION_NOTE_MAX).optional(),
      supersededBy: z.number().int().positive().optional(),
    },
  },
  questions_record_answer: {
    description:
      'Lead only: record an answer the human gave you somewhere else (in chat, in a terminal) on the item it answers, so it ' +
      'lands in the answered log and reaches the asker. Quote the human; never answer on their behalf.',
    shape: {
      n: z.number().int().positive(),
      choice: z.string().trim().max(8).optional(),
      text: z.string().max(QUESTION_ANSWER_MAX).optional(),
    },
  },
} as const

type Shapes = typeof QUESTION_TOOL_SHAPES
type Input<K extends keyof Shapes> = z.infer<z.ZodObject<Shapes[K]['shape']>>

export type QuestionAskInput = Input<'questions_ask'>
export type QuestionListInput = Input<'questions_list'>
export type QuestionUpdateInput = Input<'questions_update'>
export type QuestionCloseInput = Input<'questions_close'>
export type QuestionRecordInput = Input<'questions_record_answer'>

// Every method answers a line for the model and throws a refusal it reads as the tool's error.
export interface QuestionDirectory {
  ask(from: string, input: QuestionAskInput): Promise<string>
  list(from: string, input: QuestionListInput): Promise<string>
  update(from: string, input: QuestionUpdateInput): Promise<string>
  closeItem(from: string, input: QuestionCloseInput): Promise<string>
  recordAnswer(from: string, input: QuestionRecordInput): Promise<string>
}

const QUESTION_TOOLS = defineToolFamily<Shapes, QuestionDirectory>(QUESTION_TOOL_SHAPES, {
  questions_ask: async (directory, from, input) => ({ text: await directory.ask(from, input), isError: false }),
  questions_list: async (directory, from, input) => ({ text: await directory.list(from, input), isError: false }),
  questions_update: async (directory, from, input) => ({ text: await directory.update(from, input), isError: false }),
  questions_close: async (directory, from, input) => ({ text: await directory.closeItem(from, input), isError: false }),
  questions_record_answer: async (directory, from, input) => ({ text: await directory.recordAnswer(from, input), isError: false }),
})

export const QUESTION_TOOL_NAMES = QUESTION_TOOLS.names
export const QUESTION_TOOL_SHAPE_MAP: Shapes = QUESTION_TOOL_SHAPES

export function isQuestionToolName(name: string): name is keyof Shapes & string {
  return QUESTION_TOOLS.is(name)
}

export function runQuestionTool(
  directory: QuestionDirectory,
  from: string,
  name: keyof Shapes & string,
  args: unknown,
): Promise<GatewayToolOutput> {
  return QUESTION_TOOLS.run(directory, from, name, args)
}

export function installQuestionDirectory(directory: QuestionDirectory | undefined): void {
  QUESTION_SLOT.install(directory)
}

export function questionDirectoryHandle(own?: () => QuestionDirectory | undefined): QuestionDirectory {
  return lateBoundDirectory<QuestionDirectory>(
    ['ask', 'list', 'update', 'closeItem', 'recordAnswer'],
    QUESTION_SLOT,
    own,
    'the question board is not available on this gateway',
  )
}
