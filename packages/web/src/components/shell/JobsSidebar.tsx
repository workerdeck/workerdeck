import { useState } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import type { JobInfo, JobStatus } from '@workerdeck/protocol'
import { Badge, Button, Empty, EmptyKey, Input, Spinner, cn, formatCost, formatRelativeTime, toast, type BadgeProps } from '@workerdeck/ui'
import { ListTodo, Plus, RefreshCw, SearchX, X } from 'lucide-react'
import { ScheduleJobDialog } from '@/views/JobsView.tsx'
import { client } from '@/lib/client.ts'
import { SidebarBody, SidebarFrame } from './SidebarFrame.tsx'
import { RowAction, SidebarRow } from './SidebarRow.tsx'
import { useJobs } from '@/hooks/useJobs.ts'

export const JOB_STATUS_META: Record<JobStatus, { label: string; variant: BadgeProps['variant']; busy?: boolean }> = {
  queued: { label: 'Queued', variant: 'neutral' },
  running: { label: 'Running', variant: 'info', busy: true },
  parked: { label: 'Parked', variant: 'accent' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'danger' },
  canceled: { label: 'Canceled', variant: 'warning' },
}

const ACTIVE_JOB_STATUSES: JobStatus[] = ['queued', 'running', 'parked']

export function JobsSidebar() {
  const navigate = useNavigate()
  const activeId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/jobs\/(.+)$/)?.[1],
  })
  const { jobs, enabled, live, refresh } = useJobs()
  const [creating, setCreating] = useState(false)
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(false)

  const needle = search.trim().toLowerCase()
  const shown = [...jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter(
      (job) =>
        (!activeOnly || ACTIVE_JOB_STATUSES.includes(job.status)) &&
        (!needle ||
          job.prompt.toLowerCase().includes(needle) ||
          job.cwd.toLowerCase().includes(needle) ||
          (job.profile?.toLowerCase().includes(needle) ?? false) ||
          job.id.startsWith(needle)),
    )
  const hiding = jobs.length - shown.length

  const create = enabled ? (
    <Button variant="ghost" size="icon-sm" aria-label="Schedule a job" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
    </Button>
  ) : undefined

  return (
    <>
      <SidebarFrame
        section="jobs"
        title="Jobs"
        badge={
          enabled ? (
            <span
              aria-hidden
              title={live ? 'Streaming over the queue socket' : 'Polling'}
              className={cn('size-1.5 shrink-0 rounded-full', live ? 'bg-success' : 'bg-fg-4')}
            />
          ) : undefined
        }
        actions={
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Refresh" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
            </Button>
            {create}
          </>
        }
        railActions={create}
      >
        {!enabled ? (
          <Empty
            icon={<ListTodo />}
            title="No job queue"
            description="This gateway runs without one, so there is nothing to schedule against."
          />
        ) : (
          <>
            {jobs.length > 0 ? (
              <div className="flex items-center gap-1 px-2 pb-2">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search jobs"
                  aria-label="Search jobs"
                  className="h-7 min-w-0 flex-1 text-body-sm"
                />
                <Button
                  variant={activeOnly ? 'default' : 'outline'}
                  size="xs"
                  aria-pressed={activeOnly}
                  onClick={() => setActiveOnly(!activeOnly)}
                >
                  Active
                </Button>
              </div>
            ) : null}

            <SidebarBody>
              {jobs.length === 0 ? (
                <Empty
                  icon={<ListTodo />}
                  title="No jobs yet"
                  description={
                    <>
                      Schedule one with <EmptyKey>+</EmptyKey> above.
                    </>
                  }
                />
              ) : shown.length === 0 ? (
                <Empty
                  icon={<SearchX />}
                  title="No matches"
                  description="No job matches the active filter."
                  action="Show all"
                  onAction={() => setActiveOnly(false)}
                />
              ) : null}
              {shown.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  active={job.id === activeId}
                  onOpen={() => void navigate({ to: '/jobs/$jobId', params: { jobId: job.id } })}
                  onChanged={() => void refresh()}
                />
              ))}
              {hiding > 0 ? (
                <p className="px-1 pt-2 text-center text-label text-fg-4">
                  {shown.length} of {jobs.length}
                </p>
              ) : null}
            </SidebarBody>
          </>
        )}
      </SidebarFrame>

      <ScheduleJobDialog
        open={creating}
        onOpenChange={setCreating}
        onScheduled={() => {
          setCreating(false)
          void refresh()
        }}
      />
    </>
  )
}

function JobRow({ job, active, onOpen, onChanged }: { job: JobInfo; active: boolean; onOpen: () => void; onChanged: () => void }) {
  const meta = JOB_STATUS_META[job.status]
  // Parked jobs are live too, and cancelling one is how you abandon a wait.
  const cancellable = job.status === 'queued' || job.status === 'running' || job.status === 'parked'
  const details = [
    formatRelativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt),
    job.cwd.split('/').filter(Boolean).pop() ?? job.cwd,
  ]
  if (job.profile) {
    details.push(`@${job.profile}`)
  }
  if (job.usage.totalCostUsd > 0) {
    details.push(formatCost(job.usage.totalCostUsd))
  }
  return (
    <SidebarRow
      active={active}
      onSelect={onOpen}
      title={job.prompt}
      status={
        <Badge variant={meta.variant} dot={!meta.busy} className="shrink-0">
          {meta.busy ? <Spinner className="size-3 text-current" /> : null}
          {meta.label}
        </Badge>
      }
      description={details.join(' · ')}
      actions={
        cancellable ? (
          <RowAction
            label="Cancel job"
            onClick={() => {
              void client()
                ?.cancelJob(job.id)
                .then(onChanged)
                .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Cancel failed'))
            }}
          >
            <X className="size-3" />
          </RowAction>
        ) : null
      }
    />
  )
}
