import { useNavigate, useRouterState } from '@tanstack/react-router'
import { Badge, Empty, formatRelativeTime } from '@workerdeck/ui'
import { MessageCircleQuestion } from 'lucide-react'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { SidebarRow } from './SidebarRow.tsx'
import { useQuestions } from '@/hooks/useQuestions.ts'

export function QuestionsSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/questions\/(.+)$/)?.[1],
  })
  const { boards, enabled, error } = useQuestions()
  const open = boards.reduce((sum, board) => sum + board.open, 0)

  return (
    <SidebarFrame
      section="questions"
      title="Questions"
      badge={open > 0 ? <span className="shrink-0 text-label text-fg-4">{open}</span> : undefined}
    >
      <SidebarBody>
        {boards.length === 0 ? (
          <Empty
            icon={<MessageCircleQuestion />}
            title={enabled ? 'No questions yet' : 'Question board off'}
            description={
              error ??
              (enabled
                ? 'Agents post here with questions_ask instead of interrupting you.'
                : 'This gateway runs with the board turned off.')
            }
          />
        ) : null}
        {boards.map((board) => (
          <SidebarRow
            key={board.id}
            active={decodeURIComponent(activeId ?? '') === board.id}
            onSelect={() => void navigate({ to: '/questions/$boardId', params: { boardId: board.id } })}
            title={board.name ?? board.id}
            status={
              board.blocking > 0 ? (
                <Badge variant="danger" className="shrink-0">
                  {board.blocking} blocking
                </Badge>
              ) : board.open > 0 ? (
                <Badge variant="info" className="shrink-0">
                  {board.open} open
                </Badge>
              ) : null
            }
            description={
              <span className="min-w-0 truncate">
                {[board.team ? 'team' : 'session', `${board.answered} answered`, formatRelativeTime(board.updatedAt)]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            }
          />
        ))}
      </SidebarBody>
    </SidebarFrame>
  )
}
