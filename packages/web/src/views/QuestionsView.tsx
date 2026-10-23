import { Empty } from '@workerdeck/ui'
import { MessageCircleQuestion } from 'lucide-react'

export function QuestionsView() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Empty
        icon={<MessageCircleQuestion />}
        title="No board selected"
        description="Each team, and each session outside a team, has one board of questions waiting for you."
      />
    </div>
  )
}
