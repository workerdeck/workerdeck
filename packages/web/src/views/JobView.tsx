import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { JobInfo } from '@workerdeck/protocol'
import {
  Badge,
  Button,
  CopyButton,
  Spinner,
  formatCost,
  formatRelativeTime,
  formatTokens,
  toast,
} from '@workerdeck/ui'
import { SessionWorkspace } from '@workerdeck/ui/workspace'
import { X } from 'lucide-react'
import { DetailBar } from '@/components/shell/DetailBar.tsx'
import { JOB_STATUS_META } from '@/components/shell/JobsSidebar.tsx'
import { client } from '@/lib/client.ts'
import { primaryHost } from '@/lib/hosts.ts'
import { getRail, setRail } from '@/lib/rail.ts'
import { getTranscriptDensity, getTranscriptFont, getTranscriptVariant } from '@/lib/settings.ts'
import { useJobs } from '@/lib/useJobs.ts'
import { useSessions } from '@/lib/useSessions.ts'

/**
 * One job: what the queue knows about it, and — while its session is still in
 * the registry — the run itself, as the session workspace.
 *
 * **Read-only.** The transcript streams and the files browse, but there is no
 * composer and no approval prompts: this screen is *about* a run the queue owns,
 * and typing into it would be a second operator arriving mid-run. Cancel stays,
 * because cancelling is a queue action rather than a turn — it is how you
 * abandon a wait, and it is the only thing this page can actually decide.
 *
 * Jobs belong to the primary gateway (see `primaryClient()`), so the session
 * they ran does too.
 */
export function JobView() {
  const { jobId } = useParams({ from: '/jobs/$jobId' })
  const navigate = useNavigate()
  const { jobs, refresh } = useJobs()
  const { snapshots } = useSessions()

  const job = jobs.find((j) => j.id === jobId)
  const gateway = client()
  const hostId = primaryHost()?.id
  // Offered only while the job's session is still in the registry — a completed
  // job's session can be deleted from the Sessions view, and attaching to one
  // that is gone would render an empty transcript with no explanation.
  const live =
    job?.sessionId !== undefined &&
    (snapshots.find((s) => s.host.id === hostId)?.sessions.some((i) => i.id === job.sessionId) ??
      false)

  // A job id from a bookmark can outlive the queue's retention window. Wait for
  // the first list before deciding it is gone, or every reload would bounce.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (jobs.length > 0) setSettled(true)
  }, [jobs.length])
  useEffect(() => {
    if (!settled || job) return
    toast.error('That job is no longer in the queue')
    void navigate({ to: '/jobs' })
  }, [settled, job, navigate])

  const [density] = useState(getTranscriptDensity)
  const [variant] = useState(getTranscriptVariant)
  const [font] = useState(getTranscriptFont)
  // Read once: the workspace owns the live value from here, and re-seeding it
  // mid-view would yank the splitter out from under a drag.
  const [rail] = useState(getRail)

  if (!job) return null

  const header = <JobHeader job={job} onChanged={() => void refresh()} />

  if (!gateway || !live || !job.sessionId) {
    return (
      <div className='flex min-h-0 flex-1 flex-col'>
        {header}
        <div className='flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center'>
          <p className='text-body-sm text-fg-3'>
            {job.sessionId
              ? 'This job’s session is no longer on the gateway.'
              : 'This job never got as far as a session.'}
          </p>
          <p className='max-w-md text-label text-fg-4'>
            The queue keeps the job record — status, usage, error — but the transcript lives with
            the session, and that one has been closed or swept.
          </p>
        </div>
      </div>
    )
  }

  return (
    <SessionWorkspace
      key={job.sessionId}
      client={gateway}
      sessionId={job.sessionId}
      readOnly
      transcriptVariant={variant}
      transcriptDensity={density}
      transcriptFont={font}
      // A finished job is *only* read — which is exactly the case the rail is
      // for, and `readOnly` takes nothing away from it (it removes the composer,
      // not the ability to find your way around).
      scrubber
      // And the prompt you are waiting on, held above the answer.
      stickyPrompt
      statusPlacement='bottom'
      defaultRailWidth={rail.width}
      defaultRailCollapsed={rail.collapsed}
      onRailChange={setRail}
      // The panel's `⋯` menu is handed over the same way the session view takes
      // it: this app has a real top bar, and the run's surfaces belong there.
      header={({ actions }) => <JobHeader job={job} onChanged={() => void refresh()} actions={actions} />}
    />
  )
}

function JobHeader({
  job,
  onChanged,
  actions,
}: {
  job: JobInfo
  onChanged: () => void
  actions?: ReactNode
}) {
  const meta = JOB_STATUS_META[job.status]
  // Parked jobs are live too — cancelling one is how you abandon a wait.
  const cancellable = job.status === 'queued' || job.status === 'running' || job.status === 'parked'
  const cancel = async () => {
    try {
      await client()!.cancelJob(job.id)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cancel failed')
    }
  }
  return (
    <DetailBar
      crumbs={[{ label: 'Jobs', to: '/jobs' }, { label: job.prompt }]}
      actions={
        <>
          {/* Said rather than implied: the composer's absence is a decision, and
              a reader who expected to answer a prompt here deserves to know why. */}
          <Badge variant='neutral' className='shrink-0'>
            read-only
          </Badge>
          <CopyButton value={job.id} aria-label='Copy job id' />
          {cancellable ? (
            <Button variant='outline' size='xs' onClick={() => void cancel()}>
              <X className='size-3' />
              Cancel
            </Button>
          ) : null}
          {actions}
        </>
      }>
      <Badge variant={meta.variant} dot={!meta.busy} className='shrink-0'>
        {meta.busy ? <Spinner className='size-3 text-current' /> : null}
        {meta.label}
      </Badge>
      <div className='flex min-w-0 items-center gap-x-3 font-mono text-label text-fg-4'>
        <span className='truncate'>{job.cwd}</span>
        {job.profile ? <span className='shrink-0'>@{job.profile}</span> : null}
        <span className='shrink-0'>
          {formatRelativeTime(job.finishedAt ?? job.startedAt ?? job.createdAt)}
        </span>
        {job.maxAttempts !== undefined && job.maxAttempts > 1 ? (
          <span className='shrink-0'>
            attempt {job.attempt ?? 1}/{job.maxAttempts}
            {job.status === 'queued' && job.nextRunAt !== undefined && job.nextRunAt > Date.now()
              ? ' — retry pending'
              : ''}
          </span>
        ) : null}
        {job.usage.tokens > 0 ? (
          <span className='shrink-0'>{formatTokens(job.usage.tokens)} tok</span>
        ) : null}
        {job.usage.totalCostUsd > 0 ? (
          <span className='shrink-0'>{formatCost(job.usage.totalCostUsd)}</span>
        ) : null}
        {job.error ? <span className='truncate text-danger'>{job.error}</span> : null}
      </div>
    </DetailBar>
  )
}
