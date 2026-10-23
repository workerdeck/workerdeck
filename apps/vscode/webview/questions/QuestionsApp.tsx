import { useEffect, useMemo, useState } from 'react'
import { WorkerDeckClient } from '@workerdeck/client'
import { useQuestionBoard } from '@workerdeck/react'
import { QuestionBoard } from '@workerdeck/ui'
import type { QuestionsTarget } from '../../src/bridge-protocol.ts'
import type { AppHostMessage, Bridge } from '../bridge.ts'

export function QuestionsApp({ bridge }: { bridge: Bridge }) {
  const [target, setTarget] = useState<QuestionsTarget | undefined>()
  const [empty, setEmpty] = useState('')

  useEffect(
    () =>
      bridge.onHostMessage((msg: AppHostMessage) => {
        if (msg.kind === 'wd-questions') {
          setTarget(msg.target)
          setEmpty(msg.empty)
        }
      }),
    [bridge],
  )

  const baseUrl = target?.baseUrl
  const client = useMemo(
    () => (baseUrl ? new WorkerDeckClient({ baseUrl, fetchImpl: bridge.fetch, WebSocketImpl: bridge.WebSocketImpl }) : undefined),
    [bridge, baseUrl],
  )

  // The root takes the click focus, or VS Code's copy refocuses the last input and Cmd+C copies nothing (GOTCHAS).
  return (
    <div tabIndex={-1} className="min-h-screen p-2 outline-none">
      {client && target ? (
        <Board key={`${target.hostId}:${target.boardId}`} bridge={bridge} client={client} target={target} />
      ) : (
        <p className="p-1 text-body-sm text-fg-4">{empty}</p>
      )}
    </div>
  )
}

function Board({ bridge, client, target }: { bridge: Bridge; client: WorkerDeckClient; target: QuestionsTarget }) {
  const { board, error, answer, close } = useQuestionBoard(client, target.boardId, target.version)
  if (error) {
    return <p className="p-1 text-body-sm text-fg-4">{error}</p>
  }
  if (!board) {
    return null
  }
  return (
    <QuestionBoard
      items={board.items}
      onAnswer={answer}
      onClose={close}
      onOpenLink={(link, item) => bridge.post({ kind: 'wd-question-link', link, asker: item.asker })}
    />
  )
}
