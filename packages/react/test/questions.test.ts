import { describe, expect, it, vi } from 'vitest'
import { WorkerDeckError, type QuestionsHandleEvents, type WorkerDeckClient } from '@workerdeck/client'
import { questionBoardView, questionMatches, type QuestionBoardInfo, type QuestionItem } from '@workerdeck/protocol'
import { useQuestionBoards } from '../src/hooks/use-questions.ts'
import { renderHook } from './hook-runner.ts'

function item(n: number, fields: Partial<QuestionItem> = {}): QuestionItem {
  return {
    board: 'b',
    n,
    kind: 'decision',
    title: `Item ${n}`,
    waiting: [],
    asker: 'a',
    status: 'open',
    createdAt: n,
    updatedAt: n,
    ...fields,
  }
}

function info(id: string, fields: Partial<QuestionBoardInfo> = {}): QuestionBoardInfo {
  return { id, team: true, drafts: 0, open: 0, blocking: 0, answered: 0, closed: 0, updatedAt: 0, ...fields }
}

type Listeners = { [K in keyof QuestionsHandleEvents]?: (value: QuestionsHandleEvents[K]) => void }

function fakeClient(boards: () => Promise<QuestionBoardInfo[]>) {
  const listeners: Listeners = {}
  const detach = vi.fn()
  const client = {
    attachQuestions: () => ({
      on: <K extends keyof QuestionsHandleEvents>(kind: K, listener: (value: QuestionsHandleEvents[K]) => void) => {
        ;(listeners as Record<string, unknown>)[kind] = listener
        return () => {}
      },
      detach,
    }),
    questionBoards: boards,
  } as unknown as WorkerDeckClient
  return { client, listeners, detach }
}

describe('question board view', () => {
  it('puts blocking items first, groups open items by round in that order, newest answers first', () => {
    const view = questionBoardView([
      item(1, { round: 'pricing' }),
      item(2, { blocking: 'branch x' }),
      item(3, { round: 'pricing', blocking: 'commit y' }),
      item(4, { status: 'draft' }),
      item(5, { status: 'answered', answer: { choice: 'A', by: 't', at: 10 } }),
      item(6, { status: 'answered', answer: { text: 'later', by: 't', at: 20 } }),
      item(7, { status: 'closed', closed: { reason: 'withdrawn', by: 'a', at: 5 } }),
    ])
    expect(view.open.map((round) => [round.round, round.items.map((entry) => entry.n)])).toEqual([
      [undefined, [2]],
      ['pricing', [3, 1]],
    ])
    expect(view.drafts.map((entry) => entry.n)).toEqual([4])
    expect(view.answered.map((entry) => entry.n)).toEqual([6, 5])
    expect(view.closed.map((entry) => entry.n)).toEqual([7])
  })

  it('searches the number, title, context and the answer', () => {
    const answered = item(12, {
      status: 'answered',
      context: 'Stripe prices',
      options: [{ key: 'A', label: 'Monthly' }],
      answer: { choice: 'A', by: 't', at: 1 },
    })
    expect(questionMatches(answered, '#12')).toBe(true)
    expect(questionMatches(answered, 'stripe')).toBe(true)
    expect(questionMatches(answered, 'monthly')).toBe(true)
    expect(questionMatches(answered, 'yearly')).toBe(false)
    expect(questionMatches(answered, '  ')).toBe(true)
  })
})

describe('useQuestionBoards', () => {
  it('takes the attached boards, then folds each change in, most urgent first', async () => {
    const { client, listeners } = fakeClient(async () => [])
    const hook = renderHook(() => useQuestionBoards(client))
    listeners.attached!([info('quiet', { open: 1, updatedAt: 5 })])
    listeners.connectionChange!(true)
    listeners.changed!(info('urgent', { open: 1, blocking: 1, updatedAt: 1 }))
    listeners.changed!(info('quiet', { open: 2, updatedAt: 6 }))
    await Promise.resolve()
    expect(hook.current.boards.map((board) => [board.id, board.open])).toEqual([
      ['urgent', 1],
      ['quiet', 2],
    ])
    expect(hook.current.connected).toBe(true)
    hook.unmount()
  })

  it('reports an off board and stops the socket', async () => {
    const { client, detach } = fakeClient(async () => {
      throw new WorkerDeckError('not found', 404)
    })
    const hook = renderHook(() => useQuestionBoards(client))
    await vi.waitFor(() => expect(hook.current.supported).toBe(false))
    expect(detach).toHaveBeenCalled()
    hook.unmount()
  })
})
