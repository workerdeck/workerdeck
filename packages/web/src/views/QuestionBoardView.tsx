import { useParams } from '@tanstack/react-router'
import type { WorkerDeckClient } from '@workerdeck/client'
import { questionBoardMarkdown } from '@workerdeck/protocol'
import { useQuestionBoard } from '@workerdeck/react'
import { Button, Empty, QuestionBoard } from '@workerdeck/ui'
import { Download, MessageCircleQuestion } from 'lucide-react'
import { DetailBar, DetailBody } from '@/components/shell/DetailBar.tsx'
import { client } from '@/lib/client.ts'
import { useHosts } from '@/lib/hosts.ts'
import { useQuestions } from '@/hooks/useQuestions.ts'

export function QuestionBoardView() {
  const { boardId } = useParams({ from: '/questions/$boardId' })
  useHosts()
  const gateway = client()
  if (!gateway) {
    return null
  }
  return <BoardPage key={boardId} boardId={boardId} gateway={gateway} />
}

function BoardPage({ boardId, gateway }: { boardId: string; gateway: WorkerDeckClient }) {
  const { boards } = useQuestions()
  const info = boards.find((board) => board.id === boardId)
  const { board, error, answer, close } = useQuestionBoard(gateway, boardId, info?.updatedAt)
  const title = info?.name ?? board?.board.name ?? boardId

  return (
    <>
      <DetailBar
        crumbs={[{ label: 'Questions', to: '/questions' }, { label: title }]}
        actions={
          <Button variant="ghost" size="xs" onClick={() => void exportMarkdown(gateway, boardId, title)}>
            <Download className="size-3" />
            Markdown
          </Button>
        }
      />
      <DetailBody>
        {error ? <Empty icon={<MessageCircleQuestion />} title="Board unavailable" description={error} /> : null}
        {board ? <QuestionBoard items={board.items} onAnswer={answer} onClose={close} /> : null}
      </DetailBody>
    </>
  )
}

async function exportMarkdown(gateway: WorkerDeckClient, boardId: string, title: string): Promise<void> {
  const { board, items } = await gateway.questionBoard(boardId)
  const url = URL.createObjectURL(new Blob([questionBoardMarkdown(board, items)], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `questions-${title.replace(/[^\w.-]+/g, '-')}.md`
  link.click()
  URL.revokeObjectURL(url)
}
