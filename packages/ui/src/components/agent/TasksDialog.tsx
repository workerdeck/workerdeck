import type { SessionTask } from '@workerdeck/protocol'
import { Dialog, DialogBody, DialogContent, DialogHeader } from '../ui/Dialog.tsx'
import { TaskList } from './TaskList.tsx'

export interface TasksDialogProps {
  tasks: readonly SessionTask[]
  showCompleted: boolean
  onShowCompletedChange: (showCompleted: boolean) => void
  onSelectTask?: (task: SessionTask) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  className?: string
}

export function TasksDialog({
  tasks,
  showCompleted,
  onShowCompletedChange,
  onSelectTask,
  open,
  onOpenChange,
  className,
}: TasksDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader title="Tasks" description="The agent's checklist and the tasks it has spawned" />
        <DialogBody>
          <TaskList
            tasks={tasks}
            showCompleted={showCompleted}
            onShowCompletedChange={onShowCompletedChange}
            onSelectTask={
              onSelectTask
                ? (task) => {
                    onOpenChange(false)
                    onSelectTask(task)
                  }
                : undefined
            }
          />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
