import { ArrowRight, Check, CircleAlert, Circle } from 'lucide-react'
import { taskSummary, visibleTasks } from '@workerdeck/protocol'
import type { SessionTask } from '@workerdeck/protocol'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'

export interface TaskListProps {
  tasks: readonly SessionTask[]
  showCompleted: boolean
  // Absent where the toggle lives outside this list — VS Code puts it in the view's title bar.
  onShowCompletedChange?: (showCompleted: boolean) => void
  onSelectTask?: (task: SessionTask) => void
  className?: string
}

export function TaskList({ tasks, showCompleted, onShowCompletedChange, onSelectTask, className }: TaskListProps) {
  const summary = taskSummary(tasks)
  const shown = visibleTasks(tasks, showCompleted)
  const hidden = tasks.length - shown.length
  return (
    <div className={cn('flex flex-col', className)}>
      <div className="flex items-baseline justify-between gap-4 pb-1.5">
        <span className="text-label text-fg-3">
          {summary.done} of {summary.total} done
          {summary.failed > 0 ? ` · ${summary.failed} failed` : ''}
        </span>
        {summary.done > 0 && onShowCompletedChange ? (
          <button
            type="button"
            onClick={() => onShowCompletedChange(!showCompleted)}
            className="shrink-0 rounded-[4px] px-1 py-0.5 text-label text-fg-4 outline-none hover:bg-row-hover hover:text-fg-2"
          >
            {showCompleted ? 'Hide completed' : `Show completed (${summary.done})`}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="py-6 text-center text-body-sm text-fg-4">
          {tasks.length === 0 ? 'No tasks yet — a checklist appears once the agent plans one.' : `${hidden} completed, all hidden.`}
        </p>
      ) : (
        <div className="flex flex-col">
          {shown.map((task) => (
            <TaskRow key={task.key} task={task} onSelect={onSelectTask} />
          ))}
        </div>
      )}
    </div>
  )
}

function TaskRow({ task, onSelect }: { task: SessionTask; onSelect?: (task: SessionTask) => void }) {
  const pressable = onSelect !== undefined && task.toolUseId !== undefined
  const body = task.state === 'failed' ? 'text-danger' : task.state === 'done' ? 'text-fg-4' : 'text-fg-2'
  const row = (
    <>
      <TaskIcon state={task.state} />
      <span className={cn('min-w-0 flex-1 truncate text-left', task.state === 'done' ? 'line-through' : undefined)}>{task.label}</span>
      {task.detail ? <span className="shrink-0 tabular-nums text-fg-4">{task.detail}</span> : null}
      {pressable ? <ArrowRight className="size-3.5 shrink-0 text-fg-4" /> : null}
    </>
  )
  const className = cn('flex w-full items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-body-sm outline-none', body)
  if (!pressable) {
    return <div className={className}>{row}</div>
  }
  return (
    <button type="button" title={task.label} onClick={() => onSelect(task)} className={cn(className, 'hover:bg-row-active')}>
      {row}
    </button>
  )
}

function TaskIcon({ state }: { state: SessionTask['state'] }) {
  switch (state) {
    case 'running': {
      return <Spinner className="size-[13px] shrink-0" />
    }
    case 'failed': {
      return <CircleAlert className="size-[13px] shrink-0" />
    }
    case 'done': {
      return <Check className="size-[13px] shrink-0" />
    }
    default: {
      return <Circle className="size-[13px] shrink-0 text-fg-4" />
    }
  }
}
