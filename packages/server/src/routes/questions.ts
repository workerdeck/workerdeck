import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  questionBoardMarkdown,
  type AnswerQuestionRequest,
  type CloseQuestionRequest,
  type QuestionBoardsResponse,
} from '@workerdeck/protocol'
import type { ServerContext } from '../context.ts'
import { fail, json, readJsonBody, requireMethod } from '../lib/http.ts'
import { QuestionRefusal } from '../services/questions.ts'

export async function handleQuestions(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const questions = ctx.questions
  if (!questions) {
    fail(404, 'not found')
  }
  const url = new URL(req.url ?? '', 'http://x')
  const parts = pathname
    .slice((ctx.basePath + '/questions').length)
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part))
  try {
    if (parts.length === 0) {
      requireMethod(req, 'GET')
      json(res, 200, { boards: questions.boards() } satisfies QuestionBoardsResponse)
      return
    }
    const [boardId, rawN, action] = parts as [string, string | undefined, string | undefined]
    if (rawN === undefined) {
      requireMethod(req, 'GET')
      const board = questions.board(boardId, { drafts: url.searchParams.get('drafts') === '1' })
      if (!board) {
        fail(404, 'no such question board')
      }
      if (url.searchParams.get('format') === 'md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
        res.end(questionBoardMarkdown(board.board, board.items))
        return
      }
      json(res, 200, board)
      return
    }
    const n = Number(rawN)
    if (!Number.isInteger(n) || n < 1 || parts.length !== 3) {
      fail(404, 'not found')
    }
    requireMethod(req, 'POST')
    const body = await readJsonBody(req, ctx.maxBodyBytes)
    const by = ctx.owners.defaultOwner() ?? 'operator'
    if (action === 'answer') {
      json(res, 200, await questions.answer(boardId, n, answerRequest(body), by))
      return
    }
    if (action === 'close') {
      json(res, 200, await questions.closeByHuman(boardId, n, body as CloseQuestionRequest, by))
      return
    }
    fail(404, 'not found')
  } catch (error) {
    if (error instanceof QuestionRefusal) {
      fail(error.status, error.message)
    }
    throw error
  }
}

function answerRequest(body: Record<string, unknown>): AnswerQuestionRequest {
  return {
    ...(typeof body.choice === 'string' ? { choice: body.choice } : {}),
    ...(typeof body.text === 'string' ? { text: body.text } : {}),
  }
}
