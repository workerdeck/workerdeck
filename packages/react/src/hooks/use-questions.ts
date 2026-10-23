import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkerDeckClient } from '@workerdeck/client'
import {
  errorMessage,
  sortQuestionBoards,
  type AnswerQuestionRequest,
  type CloseQuestionRequest,
  type QuestionBoardInfo,
  type QuestionBoardResponse,
  type QuestionResponse,
} from '@workerdeck/protocol'
import { isRouteUnsupported, useAsync } from '../lib/async-guards.ts'

export type UseQuestionBoardsResult = {
  boards: QuestionBoardInfo[]
  connected: boolean
  supported: boolean
}

export type UseQuestionBoardResult = {
  board: QuestionBoardResponse | undefined
  loading: boolean
  error: string | undefined
  answer: (n: number, request: AnswerQuestionRequest) => Promise<QuestionResponse>
  close: (n: number, request: CloseQuestionRequest) => Promise<QuestionResponse>
}

export function useQuestionBoards(client: WorkerDeckClient | undefined): UseQuestionBoardsResult {
  const [boards, setBoards] = useState<QuestionBoardInfo[]>([])
  const [connected, setConnected] = useState(false)
  const [supported, setSupported] = useState(true)

  useEffect(() => {
    setBoards([])
    setConnected(false)
    setSupported(true)
    if (!client) {
      return
    }
    let live = true
    const handle = client.attachQuestions()
    handle.on('attached', (next) => setBoards(sortQuestionBoards(next)))
    handle.on('changed', (board) =>
      setBoards((current) => sortQuestionBoards([board, ...current.filter((other) => other.id !== board.id)])),
    )
    handle.on('connectionChange', setConnected)
    client.questionBoards().then(
      (next) => {
        if (live) {
          setBoards((current) => (current.length === 0 ? sortQuestionBoards(next) : current))
        }
      },
      (error: unknown) => {
        if (live && isRouteUnsupported(error)) {
          setSupported(false)
          handle.detach()
        }
      },
    )
    return () => {
      live = false
      handle.detach()
    }
  }, [client])

  return { boards, connected, supported }
}

// `version` is the board's `updatedAt` from `useQuestionBoards`: a new value refetches the items.
export function useQuestionBoard(client: WorkerDeckClient, boardId: string | undefined, version?: number): UseQuestionBoardResult {
  const { data, error, loading, reload, setData } = useAsync(() => client.questionBoard(boardId!), [client, boardId], {
    enabled: !!boardId,
  })

  const seen = useRef({ boardId, version })
  useEffect(() => {
    const previous = seen.current
    seen.current = { boardId, version }
    if (boardId && previous.boardId === boardId && previous.version !== undefined && version !== previous.version) {
      void reload()
    }
  }, [boardId, version, reload])

  const settle = useCallback(
    (response: QuestionResponse): QuestionResponse => {
      setData((current) =>
        current ? { ...current, items: current.items.map((item) => (item.n === response.item.n ? response.item : item)) } : current,
      )
      return response
    },
    [setData],
  )

  const answer = useCallback(
    async (n: number, request: AnswerQuestionRequest) => settle(await client.answerQuestion(boardId!, n, request)),
    [client, boardId, settle],
  )
  const close = useCallback(
    async (n: number, request: CloseQuestionRequest) => settle(await client.closeQuestion(boardId!, n, request)),
    [client, boardId, settle],
  )

  return { board: data, loading, error: error === undefined ? undefined : errorMessage(error, 'Question board not found'), answer, close }
}
